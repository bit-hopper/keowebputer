/**
 * lively.identity.BadgesDialog
 *
 * The owner's "Manage badges" dialog for the homestar badge row (badges.md §7.5): every badge in the
 * order the homestar shows them, each with its own who-sees choice, move up / move down buttons and a
 * remove button, with the place pinned first. The first five badges show on the home page and the rest
 * fold into "+N more"; a line in the list marks where that happens.
 *
 *   lively.identity.BadgesDialog.open({
 *     handle,         // the owner's handle (unused for saving; settings go to the signed-in user)
 *     badges,         // what GET /@handle/badges gave the owner: place first, may start with the synthetic
 *                     // place { id: "_legacy" } read through from the old public profile.location
 *     oldLocation,    // profile.location as stored now; cleared after a save (see below)
 *     onSave(info),   // after the badges were stored; info.locationCleared is true when the old public
 *                     // profile location was removed too
 *     onClose()
 *   });
 *
 * Every change (reorder, who-sees, remove) is made to a LOCAL copy of the list and only written by Save, in
 * one patchSettings call; Cancel, Escape and a click outside the panel throw the changes away. "Add badge"
 * opens the real BadgePicker on top; the picker saves its badge straight away (that is what it does on the
 * page too), and this dialog then re-reads the stored list and merges the new badge into its local copy, so
 * the order, who-sees choices and removals made so far in this dialog are kept.
 *
 * A second tab: patchSettings re-reads the stored settings before it writes. The save rebuilds the list from
 * that fresh copy, not from the one this dialog opened with: a badge removed elsewhere is not brought back,
 * a badge added elsewhere is kept (a new place replaces ours), and a badge's content comes from the fresh
 * copy while only its position and who-sees choice come from here.
 *
 * The synthetic "_legacy" place is not in state.badges at all. Saving it keeps it, with a real id, as an
 * ordinary place badge, and the old public profile.location is cleared afterwards (it is readable by anyone,
 * so a Friends-only place would still be public otherwise). Removing it clears that location too, or the
 * server would read it straight back as a place. If that clearing fails the owner is told plainly; the
 * badges are saved.
 *
 * Reorder is by buttons, so it works from the keyboard and by touch. A drag grip is not built (badges.md §8
 * phase 5 asks for buttons first).
 *
 * Layout notes (CLAUDE.md): the same dialog conventions as BadgePicker.js. The panel is built, sized and
 * placed BEFORE it is added to the scrim; native <select>s and tab stops are written on the real nodes AFTER
 * that (queued with _later); the scrim only claims clicks outside the panel; the panel and list have no mouse
 * handler of their own, so the buttons nested in them still get their clicks. Any change re-renders the whole
 * panel (at most 20 rows), then puts the list's scroll position back and the keyboard focus on the button that
 * was used, so a keyboard user can keep pressing "move up".
 *
 * Plain functions on a namespace object (no BuildSpec / addScript), so module-level vars are fine.
 */

module("lively.identity.BadgesDialog")
  .requires("lively.morphic.Complete", "lively.identity.HomestarUI", "lively.identity.HomestarBadges",
            "lively.identity.BadgePicker", "lively.identity.PostcardAudience")
  .toRun(function () {

    var UI = lively.identity.HomestarUI;
    var HB = lively.identity.HomestarBadges;

    var PAD = 24;
    var LEGACY_ID = "_legacy";
    var MAX_BADGES = 20;             // the server's cap
    var BTN = 28;                    // a round icon button
    var SELECT_W = 108, SELECT_H = 30;
    var GUTTER = 34;                 // the position number / pin at a row's left
    var FOLD_H = 26;                 // the "folded into +N more" line
    var ROW_GAP = 6;
    var PINK_HEX = "#C2447F";
    var OFF_INK = Color.rgb(200, 196, 210);     // a disabled icon button's glyph

    var VISIBILITIES = [
      { key: "anyone",  text: "Anyone" },
      { key: "friends", text: "Friends" },
      { key: "orbit",   text: "Orbit" },
      { key: "private", text: "Only me" },
    ];

    function viewportWidth() { return document.documentElement.clientWidth - 1; }

    // A badge's name as the page reads it out: "BART Orange Line", "Oakland, CA".
    function nameOf(b) {
      return [b.agency, b.label].filter(Boolean).join(" ") || b.label || b.kind;
    }

    // A fresh badge id (^[a-z0-9]{6,12}$) that is not one of `taken`.
    function newId(taken) {
      var chars = "abcdefghijklmnopqrstuvwxyz0123456789", id;
      do {
        id = "";
        for (var i = 0; i < 8; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
      } while (taken.indexOf(id) !== -1);
      return id;
    }

    // What "has anything changed" compares: the ids and who-sees choices in order. (Content cannot change here.)
    function signature(list) {
      return JSON.stringify(list.map(function (b) { return [b.id, b.visibility]; }));
    }

    function copyOf(b) { return Object.assign({}, b); }

    // ─── the dialog ───────────────────────────────────────────────────────────

    function Dialog(opts) {
      this.opts = opts;
      // The local copy being edited, and what is known to be stored (for "changed?" and for telling a badge
      // added from elsewhere from one that is already here).
      this.items = (opts.badges || []).filter(function (b) { return b && b.kind !== "more" && b.kind !== "add"; }).map(copyOf);
      this.stored = this.items.map(copyOf);
      this.known = {};
      this.items.forEach(function (b) { this.known[b.id] = true; }, this);
      this.legacy = this.items.filter(function (b) { return b.id === LEGACY_ID; })[0] || null;
      this.oldLocation = String(opts.oldLocation || "").trim();
      this.error = null;
      this.busy = false;
      this.scrim = null;
      this.panel = null;
      this.listBox = null;
      this.footerSlot = null;
      this.child = false;                 // the picker is open on top of this dialog
      this._scrollTop = 0;
      this._refocus = null;
      this.W = 560;
    }

    Dialog.prototype.open = function () {
      var self = this;
      var scrim = this.scrim = UI.viewportScrim(function () { if (self.scrim) self.render(); });
      // Only a click outside the panel is the scrim's; the rest must reach the buttons.
      scrim.onMouseUp = function (evt) {
        if (!self.panel) return false;
        if (UI.pointOnPanel(self.panel, evt)) return false;
        evt.stop();
        self.close();
        return true;
      };
      this._onKey = function (e) {
        if (e.key !== "Escape") return;
        // The picker on top has its own Escape handler; this one was registered first, so without this
        // check it would close both.
        if (self.child) return;
        e.preventDefault();
        e.stopPropagation();
        self.close();
      };
      document.addEventListener("keydown", this._onKey, true);
      this.render();
      // The badges are measured in the page font, which loads lazily: redraw once it is there.
      try {
        var text = this.items.map(function (b) { return nameOf(b) + " " + (b.abbr || ""); }).join(" ");
        document.fonts.load("700 12.5px \"Atkinson Hyperlegible\"", text + " +0123456789")
          .then(function () { if (self.scrim && !self.busy) self.render(); }).catch(function () {});
      } catch (e) { /* no FontFaceSet */ }
      return this;
    };

    Dialog.prototype.close = function () {
      if (!this.scrim) return;
      document.removeEventListener("keydown", this._onKey, true);
      UI.closeScrim(this.scrim);
      this.scrim = this.panel = this.listBox = this.footerSlot = null;
      if (this.opts.onClose) this.opts.onClose();
      // "Add badge" stores its badge at once, so a dialog that is cancelled afterwards still changed what
      // the page should show: tell it to re-read.
      if (this.storeChanged) {
        this.storeChanged = false;
        if (this.opts.onSave) this.opts.onSave({ locationCleared: this.clearedByPicker });
      }
    };

    // Runs `fn` now if the panel is already in the world, else after it has been placed. Anything that
    // needs a real DOM node (a native <select>, a tab stop, a scrollbar style) goes through here.
    Dialog.prototype._later = function (fn) {
      if (this._placed) fn(); else this._q.push(fn);
    };

    // Sized and placed before it is added (CLAUDE.md: a setPosition right after addMorph can desync the
    // render tree). The scrim's origin is the top of the viewport.
    Dialog.prototype._place = function (panel, h) {
      var vh = window.innerHeight, vw = viewportWidth(), W = this.W;
      // A panel taller than the window scrolls inside its own frame instead of pushing Save off the bottom.
      var tooTall = h > vh - 32;
      if (tooTall) { h = Math.max(240, vh - 32); panel.applyStyle({ clipMode: "auto" }); }
      panel.setExtent(lively.pt(W, h));
      panel.setPosition(lively.pt(Math.round((vw - W) / 2), Math.max(16, Math.round((vh - h) / 2))));
      this.scrim.addMorph(panel);
      this._placed = true;
      if (tooTall) this._q.push(function () { UI.scroller(panel); });
      var q = this._q;
      this._q = [];
      q.forEach(function (fn) { fn(); });
    };

    // ─── small building blocks ────────────────────────────────────────────────

    // Makes a morph reachable and usable from the keyboard: a tab stop, a pink focus ring, Enter / Space.
    Dialog.prototype._kbd = function (box, name, fn) {
      this._later(function () {
        var n = box.renderContext().shapeNode;
        n.tabIndex = 0;
        n.setAttribute("role", "button");
        n.setAttribute("aria-label", name);
        n.style.outline = "none";
        n.addEventListener("focus", function () { n.style.outline = "2px solid " + PINK_HEX; n.style.outlineOffset = "2px"; });
        n.addEventListener("blur", function () { n.style.outline = "none"; });
        n.addEventListener("keydown", function (e) {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          fn();
        });
      });
    };

    // A rounded pill that also works from the keyboard. opts as HomestarUI.pill.
    Dialog.prototype._pill = function (parent, x, y, text, opts) {
      // HomestarUI.pill keeps a disabled primary pill pink (only its border and text grey out), which
      // reads as ready; a disabled button is drawn as the plain outlined one.
      var p = UI.pill(x, y, text, opts.disabled ? Object.assign({}, opts, { primary: false }) : opts);
      parent.addMorph(p);
      if (!opts.disabled && opts.onClick) this._kbd(p, text, opts.onClick);
      if (opts.disabled) {
        this._later(function () {
          var n = p.renderContext().shapeNode;
          n.setAttribute("role", "button");
          n.setAttribute("aria-label", text);
          n.setAttribute("aria-disabled", "true");
        });
      }
      return p;
    };

    // A round 28px icon button inside a row. A disabled one is drawn pale, answers no click, is not a tab
    // stop, but still carries its name and aria-disabled so a screen reader says it is unavailable.
    // Returns { box, enabled } so the caller can put keyboard focus back on it after a re-render.
    Dialog.prototype._iconBtn = function (parent, x, y, icon, aria, enabled, onClick) {
      var box = new lively.morphic.Box(lively.rect(x, y, BTN, BTN));
      box.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: BTN / 2, handStyle: enabled ? "pointer" : "default" });
      UI.noDrag(box);
      box.addMorph(UI.icon(lively.rect(3, 3, 20, 20), icon, 16, enabled ? UI.INK : OFF_INK));
      if (enabled) {
        box.onMouseOver = function () { box.renderContext().shapeNode.style.background = "rgb(253,235,243)"; };
        box.onMouseOut = function () { box.renderContext().shapeNode.style.background = ""; };
        box.onMouseUp = function (evt) { evt.stop(); onClick(); return true; };
        this._kbd(box, aria, onClick);
      } else {
        this._later(function () {
          var n = box.renderContext().shapeNode;
          n.setAttribute("role", "button");
          n.setAttribute("aria-label", aria);
          n.setAttribute("aria-disabled", "true");
        });
      }
      parent.addMorph(box);
      return { box: box, enabled: enabled };
    };

    // The who-sees choice of one badge: a native <select> written next to the row's buttons (it has no node
    // before the row is in the world, hence _later). Lively puts a morph's submorph nodes inside an
    // "origin" node under its shape node, so the select is inserted into the same parent as the buttons,
    // right BEFORE the up button: it then shares their coordinate space (x, y are the row's own) and Tab
    // walks select, up, down, remove, the order they are drawn in. Changing it edits the local copy and
    // refreshes only the footer, so the select keeps focus.
    Dialog.prototype._select = function (item, x, y, before) {
      var self = this;
      this._later(function () {
        var ref = before.renderContext().morphNode;
        var sel = document.createElement("select");
        sel.setAttribute("aria-label", "Who can see " + nameOf(item));
        sel.setAttribute("data-badge-visibility", item.id);
        sel.style.cssText = "position:absolute;z-index:1;left:" + x + "px;top:" + y + "px;width:" + SELECT_W + "px;" +
          "height:" + SELECT_H + "px;box-sizing:border-box;padding:0 8px;font:12px sans-serif;color:#2a2438;" +
          "border:1px solid #e8e6ec;border-radius:10px;background:#fff;user-select:none;cursor:pointer;";
        VISIBILITIES.forEach(function (v) {
          var o = document.createElement("option");
          o.value = v.key;
          o.textContent = v.text;
          if (v.key === item.visibility) o.selected = true;
          sel.appendChild(o);
        });
        sel.addEventListener("focus", function () { sel.style.borderColor = "#CC0057"; });
        sel.addEventListener("blur", function () { sel.style.borderColor = "#e8e6ec"; });
        sel.addEventListener("change", function () {
          item.visibility = sel.value;
          self.error = null;
          self._fillFooter();
        });
        ref.parentNode.insertBefore(sel, ref);
      });
    };

    // ─── the list ─────────────────────────────────────────────────────────────

    // Is a badge pinned at the top? Only the place is; it keeps its who-sees choice and its remove button.
    function pinned(b) { return b.kind === "place"; }

    Dialog.prototype._canUp = function (i) {
      var it = this.items;
      return !pinned(it[i]) && i > 0 && !pinned(it[i - 1]);
    };
    Dialog.prototype._canDown = function (i) {
      return !pinned(this.items[i]) && i < this.items.length - 1;
    };

    // Swaps badge `i` with its neighbour and re-renders, asking for keyboard focus to come back to the
    // same direction's button on the badge's new row (or the other one, when it can go no further).
    Dialog.prototype._move = function (i, dir) {
      var it = this.items, j = i + dir;
      var t = it[i]; it[i] = it[j]; it[j] = t;
      this.error = null;
      this._refocus = { id: t.id, want: dir < 0 ? "up" : "down" };
      this.render();
    };

    Dialog.prototype._remove = function (i) {
      var gone = this.items.splice(i, 1)[0];
      this.error = null;
      // Focus goes to the same row (now the next badge's), else the one above, else nothing in particular.
      var next = this.items[i] || this.items[i - 1];
      this._refocus = next ? { id: next.id, want: "remove" } : null;
      this.render();
    };

    // Draws the rows into this.listBox and returns nothing; the list's height was fixed by _listHeight.
    Dialog.prototype._fillList = function (rowW, stacked, rowH) {
      var self = this, items = this.items, y = 4;
      this._btns = {};
      if (!items.length) {
        this.listBox.addMorph(UI.label(lively.rect(0, 26, this.W - 2 * PAD - 2, 40), "You have no badges yet. Choose “Add badge” to put one on your homestar.",
          { px: 13, color: UI.MUTED, align: "center", wrap: true }));
        return;
      }
      items.forEach(function (b, i) {
        if (i === HB.SHOW && items.length > HB.SHOW) {
          self._foldLine(y, rowW, items.length - HB.SHOW);
          y += FOLD_H;
        }
        self._row(b, i, y, rowW, stacked, rowH);
        y += rowH;
      });
    };

    // The line between the fifth badge and the sixth: the rest fold into "+N more" on the homestar.
    Dialog.prototype._foldLine = function (y, rowW, n) {
      var text = "Folded into “+" + n + " more” on your homestar";
      var w = Math.ceil(HB.measure(text, 11, 700)) + 24;
      var line = new lively.morphic.Box(lively.rect(4, y + 12, rowW, 1));
      line.applyStyle({ fill: UI.CARD_BORDER, borderWidth: 0 });
      UI.noDrag(line);
      line.eventsAreIgnored = true;
      this.listBox.addMorph(line);
      var cap = UI.label(lively.rect(4 + Math.round((rowW - w) / 2), y + 3, w, 18), text, { px: 11, bold: true, color: UI.MUTED, align: "center" });
      cap.applyStyle({ fill: UI.PAGE_FILL });
      this.listBox.addMorph(cap);
    };

    // One badge's row. Wide: [pin/number] [badge] ...... [who sees] [up] [down] [remove]. Narrow (a phone):
    // the badge on one line and the controls on a second.
    Dialog.prototype._row = function (b, i, y, rowW, stacked, rowH) {
      var self = this;
      var boxH = rowH - ROW_GAP;
      var row = new lively.morphic.Box(lively.rect(4, y, rowW, boxH));
      row.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 12, clipMode: "hidden" });
      UI.noDrag(row);
      this.listBox.addMorph(row);

      var innerW = rowW - 2;
      var bandH = stacked ? 48 : boxH - 2;           // the band the badge is centred in
      var name = nameOf(b);

      // Left: a pin on the place (it cannot be moved), the position number on every other badge.
      if (pinned(b)) {
        row.addMorph(UI.icon(lively.rect(8, Math.round((bandH - 20) / 2), 20, 20), "push_pin", 16, UI.MUTED));
      } else {
        row.addMorph(UI.label(lively.rect(0, Math.round((bandH - 20) / 2), GUTTER - 6, 20), String(i + 1), { px: 12, bold: true, color: UI.MUTED, align: "center" }));
      }

      // Right: the controls, laid out from the right edge.
      var rx = innerW - 8 - BTN;
      var cy = stacked ? 48 + Math.round((boxH - 2 - 48 - BTN) / 2) : Math.round((boxH - 2 - BTN) / 2);
      var up = this._iconBtn(row, rx - 8 - 2 * BTN, cy, "keyboard_arrow_up", "Move " + name + " up", this._canUp(i), function () { self._move(i, -1); });
      var dn = this._iconBtn(row, rx - 4 - BTN, cy, "keyboard_arrow_down", "Move " + name + " down", this._canDown(i), function () { self._move(i, 1); });
      var rm = this._iconBtn(row, rx, cy, "delete", "Remove " + name, true, function () { self._remove(i); });
      this._btns[b.id] = { up: up, down: dn, remove: rm };

      var selX = stacked ? GUTTER : rx - 8 - 2 * BTN - 8 - SELECT_W;
      var selY = stacked ? 48 + Math.round((boxH - 2 - 48 - SELECT_H) / 2) : Math.round((boxH - 2 - SELECT_H) / 2);
      this._select(b, selX, selY, up.box);

      // The badge itself, drawn by the same code as the page and the picker's preview.
      var maxW = stacked ? innerW - GUTTER - 8 : selX - 12 - GUTTER;
      var p = HB.plan(b, Math.max(60, maxW));
      var m = HB.make(p, GUTTER, Math.round((bandH - p.h) / 2));
      row.addMorph(m);
      this._later(function () { HB.finish(m); });
      // A library is only a stamp of letters (its name is a hover tooltip on the page), which would leave
      // several libraries indistinguishable in a list meant for managing them: say the name beside it.
      var capW = Math.floor(maxW - p.w - 10);
      if (b.kind === "library" && capW > 40) {
        row.addMorph(UI.label(lively.rect(GUTTER + p.w + 10, Math.round((bandH - 20) / 2), capW, 20), UI.trunc(b.label, 40), { px: 12, color: UI.MUTED }));
      }
    };

    // ─── render ───────────────────────────────────────────────────────────────

    Dialog.prototype.render = function () {
      if (!this.scrim) return;      // closed while a request was still on its way
      var self = this;
      // Keep the list where it was scrolled to.
      if (this.listBox) {
        try { this._scrollTop = this.listBox.renderContext().shapeNode.scrollTop; } catch (e) { /* node gone */ }
      }
      if (this.panel) this.panel.remove();
      this.panel = this.listBox = this.footerSlot = null;
      this._placed = false;
      this._q = [];
      this.W = Math.min(560, viewportWidth() - 24);

      var W = this.W, iw = W - 2 * PAD;
      var panel = this.panel = new lively.morphic.Box(lively.rect(0, 0, W, 400));
      panel.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 16, clipMode: "hidden" });
      UI.noDrag(panel);

      var y = 20;
      panel.addMorph(UI.label(lively.rect(PAD, y, iw, 24), "Manage badges", { px: 16, bold: true }));
      y += 30;
      var note = "The first " + HB.SHOW + " show on your homestar; the rest fold into “+N more”. Your place always stays first.";
      var noteLines = HB.measure(note, 12, 400) > iw - 8 ? 2 : 1;
      panel.addMorph(UI.label(lively.rect(PAD, y, iw, 18 * noteLines + 2), note, { px: 12, color: UI.MUTED, wrap: noteLines > 1 }));
      y += 18 * noteLines + 14;

      // Row geometry: narrow panels put the controls under the badge.
      var listW = iw;
      var rowW = listW - 8 - 14;                      // 4px each side, 14 for the scrollbar's reserved gutter
      var stacked = rowW < 430;
      var rowH = (stacked ? 100 : 60);
      var n = this.items.length;
      var contentH = n ? 8 + n * rowH + (n > HB.SHOW ? FOLD_H : 0) : 90;
      var below = 12 + 38 + 34 + 22;                  // gap, status line, buttons, bottom padding
      var maxList = Math.max(150, Math.min(440, window.innerHeight - 32 - y - below));
      var listH = Math.min(contentH, maxList);

      var box = this.listBox = new lively.morphic.Box(lively.rect(PAD, y, listW, listH));
      box.applyStyle({ fill: UI.PAGE_FILL, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 12, clipMode: "auto" });
      UI.noDrag(box);
      panel.addMorph(box);
      this._fillList(rowW, stacked, rowH);
      this._later(function () {
        UI.scroller(box);
        box.renderContext().shapeNode.scrollTop = self._scrollTop;
      });
      y += listH + 12;

      var slot = this.footerSlot = new lively.morphic.Box(lively.rect(0, y, W, 72));
      slot.applyStyle({ fill: null, borderWidth: 0, clipMode: "visible" });
      UI.noDrag(slot);
      panel.addMorph(slot);
      this._fillFooter();

      this._place(panel, y + 72 + 8);
      this._restoreFocus();
    };

    // Puts keyboard focus back on the button that was just used, on the badge's new row. When that button
    // is no longer available (it reached the top or bottom), the other direction's takes the focus.
    Dialog.prototype._restoreFocus = function () {
      var r = this._refocus;
      this._refocus = null;
      if (!r || !this._btns || !this._btns[r.id]) return;
      var set = this._btns[r.id];
      var order = r.want === "remove" ? ["remove"] : r.want === "up" ? ["up", "down", "remove"] : ["down", "up", "remove"];
      for (var k = 0; k < order.length; k++) {
        var b = set[order[k]];
        if (b && b.enabled !== false) {
          var node = b.box.renderContext().shapeNode;
          if (node && node.focus) node.focus();
          return;
        }
      }
    };

    // ─── footer: status line, Add badge / Cancel / Save ───────────────────────

    Dialog.prototype._dirty = function () {
      return signature(this.items) !== signature(this.stored);
    };

    // Rebuilt on every change because Save switches between disabled and ready.
    Dialog.prototype._fillFooter = function () {
      var self = this, slot = this.footerSlot, W = this.W, iw = W - 2 * PAD;
      if (!slot) return;
      slot.submorphs.slice().forEach(function (m) { m.remove(); });
      var dirty = this._dirty();
      var msg = this.error || (dirty ? "You have unsaved changes." : "");
      if (msg) slot.addMorph(UI.label(lively.rect(PAD, 0, iw, 36), msg, { px: 12, bold: !!this.error, color: this.error ? UI.PINK : UI.MUTED, wrap: true }));
      var y = 40;
      this._pill(slot, PAD, y, "Add badge", { primary: false, w: 112, disabled: this.busy, onClick: function () { self._add(); } });
      this._pill(slot, W - PAD - 100 - 8 - 92, y, "Cancel", { primary: false, w: 92, onClick: function () { self.close(); } });
      this._pill(slot, W - PAD - 100, y, this.busy ? "Saving…" : "Save", {
        primary: true, w: 100, disabled: !dirty || this.busy, onClick: function () { self._save(); },
      });
    };

    // ─── Add badge: the real picker on top, then merge what it stored ─────────

    Dialog.prototype._add = function () {
      var self = this;
      if (this.busy || this.child) return;
      this.child = true;
      lively.identity.BadgePicker.open({
        handle: this.opts.handle,
        badges: this.items,
        oldLocation: this.oldLocation,
        onSave: function (info) {
          // The picker already stored its badge (and cleared the old public location when it was a place).
          self.storeChanged = true;
          if (info && info.locationCleared) { self.oldLocation = ""; self.legacy = null; self.clearedByPicker = true; }
          self._mergeStored();
        },
        onClose: function () {
          // onClose runs before onSave when a badge was added; the merge re-enables the dialog. A plain
          // cancel has nothing to merge.
          self.child = false;
        },
      });
    };

    // Re-reads the stored badges and brings what the picker added into the local copy, keeping everything
    // done here so far. A new place replaces the local one (including the synthetic one) and goes first.
    Dialog.prototype._mergeStored = function () {
      var self = this;
      lively.identity.postcardAudience.readSettingsState(function (err, state) {
        if (!self.scrim) return;
        if (err) {
          self.error = "The badge was saved, but the list could not be refreshed: " + ((err && err.message) || err);
          self._fillFooter();
          return;
        }
        var fresh = Array.isArray(state.badges) ? state.badges : [];
        var added = fresh.filter(function (b) { return !self.known[b.id]; });
        added.forEach(function (b) {
          self.known[b.id] = true;
          if (b.kind === "place") {
            self.items = self.items.filter(function (x) { return x.kind !== "place"; });
            self.items.unshift(copyOf(b));
          } else {
            self.items.push(copyOf(b));
          }
        });
        // What is stored now: the old public location is read through as a place only while there is no real one.
        var hasPlace = fresh.some(function (b) { return b.kind === "place"; });
        self.stored = (hasPlace || !self.legacy ? [] : [copyOf(self.legacy)]).concat(fresh.map(copyOf));
        if (hasPlace) self.legacy = null;
        self.error = null;
        self.render();
      });
    };

    // ─── saving ───────────────────────────────────────────────────────────────

    Dialog.prototype._save = function () {
      var self = this;
      if (this.busy || !this._dirty()) return;
      var working = this.items.map(copyOf);
      var known = Object.assign({}, this.known);
      this.busy = true;
      this.error = null;
      this._fillFooter();
      lively.identity.postcardAudience.patchSettings(function (state) {
        var fresh = Array.isArray(state.badges) ? state.badges : [];
        var byId = {};
        fresh.forEach(function (b) { byId[b.id] = b; });
        var taken = fresh.map(function (b) { return b.id; }).concat(working.map(function (b) { return b.id; }));
        var out = [];
        working.forEach(function (w) {
          if (w.id === LEGACY_ID) {
            // The old public location becomes an ordinary place badge, with a real id.
            var legacyBadge = copyOf(w);
            legacyBadge.id = newId(taken);
            out.push(legacyBadge);
          } else if (byId[w.id]) {
            // Content from the fresh copy; only the position and who-sees choice are ours.
            var b = copyOf(byId[w.id]);
            b.visibility = w.visibility;
            out.push(b);
          }
          // else: removed from another tab since this dialog opened; not brought back.
        });
        // Added from another tab since: keep them. A new place replaces ours.
        fresh.forEach(function (f) {
          if (known[f.id]) return;
          if (f.kind === "place") {
            out = out.filter(function (x) { return x.kind !== "place"; });
            out.unshift(copyOf(f));
          } else {
            out.push(copyOf(f));
          }
        });
        state.badges = out;
      }, function (err) {
        if (err) {
          self.busy = false;
          self.error = "Could not save: " + ((err && err.message) || err);
          if (self.scrim) self._fillFooter();
          return;
        }
        if (!self.oldLocation) return self._done({});
        // The old public location must go too: kept as a place it is now a badge with its own who-sees
        // choice, removed it must not be read back as one.
        lively.require("lively.identity.UserSpace").toRun(function () {
          lively.identity.userSpace.saveProfile({ location: "" }, function (err2) {
            if (!err2) return self._done({ locationCleared: true });
            self._done({});
            $world.alert("Your badges are saved, but the old public location could not be removed: " + ((err2 && err2.message) || err2));
          });
        });
      });
    };

    Dialog.prototype._done = function (info) {
      this.busy = false;
      this.storeChanged = false;          // this save reports everything, the picker's badge included
      this.close();
      if (this.opts.onSave) this.opts.onSave({ locationCleared: !!(info.locationCleared || this.clearedByPicker) });
    };

    lively.identity.BadgesDialog = {
      open: function (opts) { return new Dialog(opts || {}).open(); },
      // Exposed for the tests.
      signature: signature,
      nameOf: nameOf,
    };

  }); // end module('lively.identity.BadgesDialog')
