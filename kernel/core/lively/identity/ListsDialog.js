/**
 * lively.identity.ListsDialog
 *
 * "Your lists": make, rename, change the members of and delete the owner's named
 * friend lists (the ones the audience dialog offers next to Friends and Orbit).
 * Every change is saved straight away, to the owner's private settings
 * (PostcardAudience.saveLists), and the dialog hands the lists as stored back so
 * the caller can redraw.
 *
 *   lively.identity.ListsDialog.open({
 *     ctx,                   // from PostcardAudience.loadContext (friendDids, handleByDid, lists)
 *     onChange(lists),       // after every successful save; lists is what the server stored
 *     onClose()
 *   });
 *
 * Two screens: the list of lists, and the editor for one (a name and the friends on
 * it). Members can only be friends (the server drops anyone else). The rules for ids
 * and names are in AudienceRules.js. Everything is a morph, except the name field,
 * which is a native <input> inside the panel (CLAUDE.md "Native HTML dialogs/overlays").
 * Rows are boxes that own the click, with non-interactive children (CLAUDE.md
 * "Mouse dispatch is capture-first").
 */

module("lively.identity.ListsDialog")
  .requires("lively.morphic.Complete", "lively.identity.HomestarUI", "lively.identity.AudienceRules", "lively.identity.PostcardAudience")
  .toRun(function () {

    var UI = lively.identity.HomestarUI;
    var R = lively.identity.AudienceRules;

    var W = 460;
    var PAD = 24;
    var ROW_H = 52;
    var PICKER_ROW_H = 34;
    var PICKER_MAX_H = 220;
    var INPUT_H = 34;
    var HELP = "A list is a group of your friends you can share a postcard with in one tick. " +
      "People you take off a list lose access to the cards shared through it.";

    function atHandle(handle) { return "@" + handle; }

    // One px short of clientWidth, as AudienceDialog does: a scrim exactly as wide as
    // the viewport makes the page scroll sideways once a vertical scrollbar exists.
    function viewportWidth() { return document.documentElement.clientWidth - 1; }

    function linesFor(text, px, width) {
      return Math.max(1, Math.ceil(UI.textW(text, px, false) / width));
    }

    function Dialog(opts) {
      this.opts = opts;
      this.ctx = opts.ctx;
      this.lists = (opts.ctx.lists || []).map(function (l) {
        return { id: l.id, name: l.name, memberDids: (l.memberDids || []).slice() };
      });
      this.mode = "list";           // "list" | "edit"
      this.draft = null;            // { id, isNew, name, memberDids } while editing
      this.error = null;
      this.busy = false;
      this.confirmDelete = false;
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
      this.render();
      return this;
    };

    Dialog.prototype.close = function () {
      if (!this.scrim) return;
      UI.closeScrim(this.scrim);
      this.scrim = this.panel = null;
      if (this.opts.onClose) this.opts.onClose();
    };

    // The lists as they are now, for the caller and for the shared ctx.
    Dialog.prototype._publish = function (lists) {
      this.lists = lists;
      this.ctx.lists = lists;
      if (this.opts.onChange) this.opts.onChange(lists);
    };

    Dialog.prototype._save = function (lists, thenDo) {
      var self = this;
      this.busy = true;
      this.error = null;
      this.render();
      lively.identity.postcardAudience.saveLists(lists, function (err, state) {
        self.busy = false;
        if (err) {
          self.error = "Could not save: " + (err.message || err);
          if (self.scrim) self.render();
          return;
        }
        self._publish((state && state.audienceLists) || lists);
        thenDo();
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

    // ─── screens ─────────────────────────────────────────────────────────────

    Dialog.prototype._startEdit = function (list) {
      this.mode = "edit";
      this.error = null;
      this.confirmDelete = false;
      this.draft = list
        ? { id: list.id, isNew: false, name: list.name, memberDids: list.memberDids.slice() }
        : { id: R.newListId(this.lists), isNew: true, name: "", memberDids: [] };
      this.render();
    };

    Dialog.prototype._backToList = function () {
      this.mode = "list";
      this.draft = null;
      this.error = null;
      this.confirmDelete = false;
      this.render();
    };

    Dialog.prototype._commitDraft = function () {
      var self = this;
      var d = this.draft;
      var err = R.listNameError(d.name, this.lists, d.id);
      if (!err && d.isNew && this.lists.length >= R.MAX_LISTS) err = "You can have at most " + R.MAX_LISTS + " lists";
      if (err) { this.error = err; return this.render(); }
      var entry = { id: d.id, name: d.name.trim(), memberDids: d.memberDids.slice() };
      var next = d.isNew
        ? this.lists.concat([entry])
        : this.lists.map(function (l) { return l.id === d.id ? entry : l; });
      this._save(next, function () { self._backToList(); });
    };

    Dialog.prototype._deleteDraft = function () {
      var self = this;
      if (!this.confirmDelete) { this.confirmDelete = true; return this.render(); }
      var id = this.draft.id;
      this._save(this.lists.filter(function (l) { return l.id !== id; }), function () { self._backToList(); });
    };

    Dialog.prototype._friendCount = function (list) {
      var friends = this.ctx.friendDids || [];
      return (list.memberDids || []).filter(function (d) { return friends.indexOf(d) !== -1; }).length;
    };

    Dialog.prototype._listRow = function (panel, y, list) {
      var self = this;
      var n = this._friendCount(list);
      var row = new lively.morphic.Box(lively.rect(PAD - 8, y, W - 2 * PAD + 16, ROW_H));
      row.applyStyle({ fill: Color.white, borderWidth: 0, borderRadius: 10, clipMode: "hidden", handStyle: "pointer" });
      UI.noDrag(row);
      row.addMorph(UI.icon(lively.rect(8, 15, 22, 22), "label", 20, UI.PINK));
      row.addMorph(UI.label(lively.rect(44, 8, W - 2 * PAD - 80, 20), UI.trunc(list.name, 34), { px: 13, bold: true }));
      row.addMorph(UI.label(lively.rect(44, 28, W - 2 * PAD - 80, 18), n + (n === 1 ? " person" : " people"), { px: 11, color: UI.MUTED }));
      row.addMorph(UI.icon(lively.rect(W - 2 * PAD - 12, 14, 24, 24), "chevron_right", 22, UI.MUTED));
      row.onMouseOver = function () { row.applyStyle({ fill: UI.PINK_SOFT }); };
      row.onMouseOut = function () { row.applyStyle({ fill: Color.white }); };
      row.onMouseUp = function (evt) { evt.stop(); self._startEdit(list); return true; };
      panel.addMorph(row);
    };

    // The friends picker in the editor. Returns its height.
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
        var on = self.draft.memberDids.indexOf(did) !== -1;
        var r = new lively.morphic.Box(lively.rect(4, 4 + i * PICKER_ROW_H, W - 2 * PAD - 8 - 14, PICKER_ROW_H));
        r.applyStyle({ fill: null, borderWidth: 0, borderRadius: 8, handStyle: "pointer" });
        UI.noDrag(r);
        r.addMorph(self._checkbox(8, 7, on));
        r.addMorph(UI.label(lively.rect(40, 7, W - 2 * PAD - 100, 20), handle ? atHandle(handle) : "(unknown)", { px: 13 }));
        r.onMouseUp = function (evt) {
          evt.stop();
          self.draft.memberDids = R.toggleDid(self.draft.memberDids, did);
          self.render();
          return true;
        };
        box.addMorph(r);
      });
      panel.addMorph(box);
      UI.scroller(box);
      return h;
    };

    // The name field: a native input inside the panel's own node. Added after the panel
    // is in the world (it has no node before that).
    Dialog.prototype._addNameInput = function (top) {
      var self = this;
      var node = this.panel.renderContext().shapeNode;
      var input = document.createElement("input");
      input.type = "text";
      input.maxLength = R.MAX_LIST_NAME;
      input.value = this.draft.name;
      input.placeholder = "For example: Book club";
      input.setAttribute("aria-label", "List name");
      input.style.cssText = "position:absolute;left:" + PAD + "px;top:" + top + "px;width:" + (W - 2 * PAD) + "px;" +
        "height:" + INPUT_H + "px;box-sizing:border-box;padding:0 12px;font:13px sans-serif;color:#2a2438;" +
        "border:1px solid #e8e6ec;border-radius:10px;outline:none;background:#fff;user-select:text;";
      input.addEventListener("focus", function () { input.style.borderColor = "#CC0057"; });
      input.addEventListener("blur", function () { input.style.borderColor = "#e8e6ec"; });
      input.addEventListener("input", function () { self.draft.name = input.value; });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); self.draft.name = input.value; self._commitDraft(); }
        else if (e.key === "Escape") { e.preventDefault(); self._backToList(); }
      });
      node.appendChild(input);
      this._input = input;
      return input;
    };

    Dialog.prototype.render = function () {
      var self = this;
      if (!this.scrim) return;      // closed while a save was still on its way
      if (this.panel) this.panel.remove();
      this._input = null;

      var panel = this.panel = new lively.morphic.Box(lively.rect(0, 0, W, 400));
      panel.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 16, clipMode: "hidden" });
      UI.noDrag(panel);

      var textW = W - 2 * PAD;
      var y = 20;
      var inputTop = null;
      var buttons = [];       // [{ text, primary, w, onClick, danger }] laid out right to left
      var leftButton = null;  // an optional button at the left edge

      if (this.mode === "list") {
        panel.addMorph(UI.label(lively.rect(PAD, y, textW, 24), "Your lists", { px: 16, bold: true }));
        y += 28;
        var hh = 18 * linesFor(HELP, 11, textW) + 4;
        panel.addMorph(UI.label(lively.rect(PAD, y, textW, hh), HELP, { px: 11, color: UI.MUTED, wrap: true }));
        y += hh + 10;
        if (!this.lists.length) {
          panel.addMorph(UI.label(lively.rect(PAD, y, textW, 20), "You have no lists yet.", { px: 13, color: UI.MUTED }));
          y += 34;
        }
        this.lists.forEach(function (l) { self._listRow(panel, y, l); y += ROW_H; });
        y += 10;
        leftButton = { text: "New list", primary: false, w: 100, onClick: function () { self._startEdit(null); } };
        buttons.push({ text: "Done", primary: true, w: 92, onClick: function () { self.close(); } });
      } else {
        var d = this.draft;
        panel.addMorph(UI.label(lively.rect(PAD, y, textW, 24), d.isNew ? "New list" : "Edit list", { px: 16, bold: true }));
        y += 34;
        panel.addMorph(UI.label(lively.rect(PAD, y, textW, 18), "Name", { px: 12, bold: true, color: UI.MUTED }));
        y += 22;
        inputTop = y;
        y += INPUT_H + 14;
        var count = d.memberDids.length;
        panel.addMorph(UI.label(lively.rect(PAD, y, textW - 120, 18), "Who is on it", { px: 12, bold: true, color: UI.MUTED }));
        panel.addMorph(UI.label(lively.rect(W - PAD - 120, y, 120, 18), count + " selected", { px: 12, color: UI.MUTED, align: "right" }));
        y += 24;
        y += this._picker(panel, y) + 10;
        if (this.error) {
          panel.addMorph(UI.label(lively.rect(PAD, y, textW, 18 * linesFor(this.error, 12, textW) + 4), this.error,
            { px: 12, color: UI.PINK, bold: true, wrap: true }));
          y += 18 * linesFor(this.error, 12, textW) + 8;
        }
        y += 4;
        if (!d.isNew) {
          leftButton = {
            text: this.confirmDelete ? "Really delete?" : "Delete list", primary: false, w: 118, danger: true,
            onClick: function () { self._deleteDraft(); }
          };
        }
        buttons.push({ text: this.busy ? "Saving…" : "Save", primary: true, w: 92, disabled: this.busy, onClick: function () { self._commitDraft(); } });
        buttons.push({ text: "Cancel", primary: false, w: 92, onClick: function () { self._backToList(); } });
      }

      if (this.mode === "list" && this.error) {
        panel.addMorph(UI.label(lively.rect(PAD, y, textW, 18 * linesFor(this.error, 12, textW) + 4), this.error,
          { px: 12, color: UI.PINK, bold: true, wrap: true }));
        y += 18 * linesFor(this.error, 12, textW) + 8;
      }

      var x = W - PAD;
      buttons.forEach(function (b) {
        x -= b.w;
        var pill = UI.pill(0, y, b.text, { primary: b.primary, w: b.w, disabled: b.disabled, onClick: b.onClick });
        pill.setPosition(lively.pt(x, y));
        panel.addMorph(pill);
        x -= 8;
      });
      if (leftButton) {
        var left = UI.pill(0, y, leftButton.text, { primary: false, w: leftButton.w, disabled: this.busy, onClick: leftButton.onClick });
        left.setPosition(lively.pt(PAD, y));
        panel.addMorph(left);
      }
      y += 30 + 22;

      // Sized and placed before it is added (CLAUDE.md: a setPosition right after addMorph
      // can desync the render tree). The scrim's origin is the top of the viewport.
      var vh = window.innerHeight, vw = viewportWidth();
      panel.setExtent(lively.pt(W, y));
      panel.setPosition(lively.pt(Math.round((vw - W) / 2), Math.max(16, Math.round((vh - y) / 2))));
      this.scrim.addMorph(panel);

      if (inputTop !== null) {
        var input = this._addNameInput(inputTop);
        if (!this._focusedOnce) { this._focusedOnce = true; setTimeout(function () { input.focus(); }, 0); }
      } else {
        this._focusedOnce = false;
      }
    };

    lively.identity.ListsDialog = {
      open: function (opts) { return new Dialog(opts).open(); }
    };

  }); // end module('lively.identity.ListsDialog')
