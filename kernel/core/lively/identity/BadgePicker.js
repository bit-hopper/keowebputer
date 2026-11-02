/**
 * lively.identity.BadgePicker
 *
 * The owner's "Add badge" dialog for the homestar badge row (badges.md §7.2-7.4): step 1
 * picks a kind (a place, a transit line, a school or community, a library, a team), step 2
 * fills in that kind with a LIVE PREVIEW drawn by the same code the home page uses
 * (HomestarBadges.plan / make / finish, so what you see is the badge that gets saved),
 * the who-sees choice, and Back / Cancel / Add badge.
 *
 *   lively.identity.BadgePicker.open({
 *     handle,                // the owner's handle (unused for saving; settings go to the signed-in user)
 *     badges,                // the badges the page shows now (to say "this replaces ...", and the 20 cap)
 *     oldLocation,           // profile.location as stored now; cleared after a place is saved (see below)
 *     onSave(info),          // after the badge was stored; info.locationCleared is true when the old
 *                            // public profile location was removed too
 *     onClose()
 *   });
 *
 * Saving goes through postcardAudience.patchSettings, which re-reads the stored settings first, so a
 * change made from another tab is not overwritten; the new badge is appended to state.badges (a place
 * replaces the existing one and goes first). The server validates and normalises again (Badges.js);
 * this dialog only keeps the owner from sending what it would refuse.
 *
 * A place also has to leave the public profile: profile.location is readable by anyone, so once a real
 * place badge exists (it has its own who-sees choice) the old value is cleared, or a Friends-only place
 * would still be public. If that clearing fails the owner is told plainly; the badge itself is saved.
 *
 * Colour: a custom colour is one fill; the text colour is chosen for it (BadgeCatalog.textColorFor:
 * white, else the page ink, else black), so every valid fill reaches the 4.5:1 rule and only a
 * malformed hex is refused.
 *
 * Layout notes (CLAUDE.md): the panel is built, sized and placed BEFORE it is added to the scrim; native
 * inputs and tab stops are written on the real nodes AFTER that (queued with _later); the scrim only
 * claims clicks outside the panel; the panel and the list containers have no mouse handler of their
 * own, so the rows nested in them still get their clicks. Typing refreshes only the "dynamic" parts
 * (preview, list, colour block, footer) and never rebuilds a native input, so focus and caret stay.
 *
 * Plain functions on a namespace object (no BuildSpec / addScript), so module-level vars are fine.
 */

module("lively.identity.BadgePicker")
  .requires("lively.morphic.Complete", "lively.identity.HomestarUI", "lively.identity.HomestarBadges",
            "lively.identity.BadgeCatalog", "lively.identity.PostcardAudience", "lively.identity.NatalChart")
  .toRun(function () {

    var UI = lively.identity.HomestarUI;
    var HB = lively.identity.HomestarBadges;
    var Cat = lively.identity.BadgeCatalog;

    var PAD = 24;
    var ROW = 34;                    // a list row
    var LIST_ROWS = 5;               // rows visible before a list scrolls
    var MAX_BADGES = 20;             // the server's cap
    var PREVIEW_H = 76;
    var AGENCY_ONLY = "\u0000agency-only";
    var CUSTOM_ROW = "\u0000custom";
    var PINK_HEX = "#C2447F";
    var STOP_WORDS = { the: 1, of: 1, and: 1, a: 1, an: 1, at: 1, for: 1 };

    // Fills offered for a custom badge. The text colour is picked per fill, never stored here.
    var SWATCHES = ["#C2447F", "#B3261E", "#D9531E", "#C77700", "#7A6A00", "#2E7D32",
                    "#00796B", "#0277BD", "#1A4FA0", "#5B2A86", "#6D4C41", "#37474F"];

    var VISIBILITIES = [
      { key: "anyone",  text: "Anyone",  desc: "Anyone who visits your homestar can see this badge." },
      { key: "friends", text: "Friends", desc: "Only your friends can see this badge." },
      { key: "orbit",   text: "Orbit",   desc: "Only the friends in your orbit can see this badge." },
      { key: "private", text: "Only me", desc: "Only you can see this badge." },
    ];

    // The five kinds, in the order of step 1. `sample` is a real badge drawn on the tile.
    var KINDS = [
      { key: "place", title: "A place", formTitle: "Add a place",
        desc: "Where you are, or what you call home.",
        sample: function () { return { kind: "place", label: "Oakland, CA" }; } },
      { key: "transit", title: "A transit line", formTitle: "Add a transit line",
        desc: "A line or route you ride.",
        sample: function () { var l = Cat.AGENCIES[0].lines[0]; return { kind: "transit", agency: Cat.AGENCIES[0].label, label: l.label, color: l.color, textColor: l.textColor }; } },
      { key: "school", title: "A school or community", formTitle: "Add a school or community",
        desc: "Where you study, or a group you belong to.",
        sample: function () { var s = Cat.SCHOOLS[0]; return { kind: "school", label: s.name, color: s.color, textColor: s.textColor }; } },
      { key: "library", title: "A library", formTitle: "Add a library",
        desc: "Your local library, as a stamp.",
        sample: function () { return { kind: "library", id: "sample01", label: "Oakland Public Library", abbr: "OPL" }; } },
      { key: "team", title: "A team", formTitle: "Add a team",
        desc: "A club or team you follow.",
        sample: function () { var t = Cat.TEAMS[0]; return { kind: "team", label: t.name, abbr: t.abbr, color: t.color, textColor: t.textColor }; } },
    ];

    function kindOf(key) { return KINDS.filter(function (k) { return k.key === key; })[0]; }
    function agencyOf(key) { return Cat.AGENCIES.filter(function (a) { return a.key === key; })[0]; }
    function viewportWidth() { return document.documentElement.clientWidth - 1; }

    // Control characters out, whitespace collapsed, cut to `max`: the same cleaning the server applies.
    function clean(s, max) {
      return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
    }

    // Letters and digits only, upper case, at most `max`.
    function cleanAbbr(s, max) {
      return String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, max);
    }

    // A guess at an abbreviation from a name: the first letters of its words ("Oakland Public Library"
    // gives OPL), skipping small words; a single word gives its first letters.
    function initials(name, max) {
      var words = String(name || "").split(/\s+/).filter(function (w) { return /^[A-Za-z0-9]/.test(w); });
      var big = words.filter(function (w) { return !STOP_WORDS[w.toLowerCase()]; });
      if (big.length) words = big;
      if (words.length === 1) return cleanAbbr(words[0], Math.min(max, 3));
      return cleanAbbr(words.map(function (w) { return w.charAt(0); }).join(""), max);
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

    // '#rrggbb' (or 'rrggbb') to '#RRGGBB', or null.
    function parseHex(s) {
      var m = /^#?([0-9a-fA-F]{6})$/.exec(String(s || "").trim());
      return m ? "#" + m[1].toUpperCase() : null;
    }

    function freshState(kind) {
      return {
        place: "", pickedCity: null,
        agencyKey: Cat.AGENCIES[0].key, pick: null, query: "", agency: "", line: "",
        league: "All", custom: false, name: "", abbr: "", abbrTouched: false,
        color: null, hexText: "", hexBad: false,
      };
    }

    // ─── the dialog ───────────────────────────────────────────────────────────

    function Dialog(opts) {
      this.opts = opts;
      this.existing = (opts.badges || []).filter(function (b) { return b && b.id !== "_legacy"; });
      this.id = newId(this.existing.map(function (b) { return b.id; }));
      this.step = "kind";
      this.kind = null;
      this.f = freshState();
      this.visibility = "anyone";
      this.error = null;
      this.busy = false;
      this.scrim = null;
      this.panel = null;
      this.W = 520;
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
      // The sample badges are measured in the page font, which loads lazily: redraw once it is there.
      try {
        document.fonts.load("700 12.5px \"Atkinson Hyperlegible\"", "Oakland, CA BART Orange Line UC Berkeley OPL Warriors GSW +0123456789")
          .then(function () { if (self.scrim && self.step === "kind") self.render(); }).catch(function () {});
      } catch (e) { /* no FontFaceSet */ }
      return this;
    };

    Dialog.prototype.close = function () {
      if (!this.scrim) return;
      document.removeEventListener("keydown", this._onKey, true);
      UI.closeScrim(this.scrim);
      this.scrim = this.panel = this.dyn = this.previewBox = this.footerSlot = null;
      if (this.opts.onClose) this.opts.onClose();
    };

    // Runs `fn` now if the panel is already in the world, else after it has been placed. Anything that
    // needs a real DOM node (a native input, a tab stop, a scrollbar style) goes through here.
    Dialog.prototype._later = function (fn) {
      if (this._placed) fn(); else this._q.push(fn);
    };

    // Sized and placed before it is added (CLAUDE.md: a setPosition right after addMorph can desync the
    // render tree). The scrim's origin is the top of the viewport.
    Dialog.prototype._place = function (panel, h) {
      var vh = window.innerHeight, vw = viewportWidth(), W = this.W;
      // A panel taller than the window (a short laptop screen, the team form) scrolls inside its own
      // frame instead of pushing Add badge off the bottom.
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

    Dialog.prototype.render = function () {
      if (!this.scrim) return;      // closed while a request was still on its way
      if (this.panel) this.panel.remove();
      this.panel = this.dyn = this.previewBox = this.footerSlot = null;
      this._placed = false;
      this._q = [];
      this._inputs = [];
      this._dynFn = null;
      this.W = Math.min(520, viewportWidth() - 24);

      var panel = this.panel = new lively.morphic.Box(lively.rect(0, 0, this.W, 400));
      panel.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 16, clipMode: "hidden" });
      UI.noDrag(panel);

      var h = this.step === "kind" ? this._renderKinds(panel) : this._renderForm(panel);
      this._place(panel, h);
      if (this._focusFirst && this._inputs[0]) this._inputs[0].focus();
      this._focusFirst = false;
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
        // Not a tab stop, but still named, so a screen reader finds it and says it is unavailable.
        this._later(function () {
          var n = p.renderContext().shapeNode;
          n.setAttribute("role", "button");
          n.setAttribute("aria-label", text);
          n.setAttribute("aria-disabled", "true");
        });
      }
      return p;
    };

    // A native text input on the panel's own node (it has none before it is in the world, hence _later).
    // o: { x, y, w, value, max, placeholder, aria, onInput(value, input), onEnter() }
    Dialog.prototype._input = function (o) {
      var self = this;
      this._later(function () {
        var node = self.panel.renderContext().shapeNode;
        var input = document.createElement("input");
        input.type = "text";
        input.maxLength = o.max;
        input.value = o.value || "";
        input.placeholder = o.placeholder || "";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.setAttribute("aria-label", o.aria);
        input.style.cssText = "position:absolute;left:" + o.x + "px;top:" + o.y + "px;width:" + o.w + "px;" +
          "height:38px;box-sizing:border-box;padding:0 12px;font:13px sans-serif;color:#2a2438;" +
          "border:1px solid #e8e6ec;border-radius:10px;outline:none;background:#fff;user-select:text;";
        input.addEventListener("focus", function () { input.style.borderColor = "#CC0057"; });
        input.addEventListener("blur", function () { input.style.borderColor = "#e8e6ec"; });
        input.addEventListener("input", function () { o.onInput(input.value, input); });
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); if (o.onEnter) o.onEnter(); }
        });
        node.appendChild(input);
        self._inputs.push(input);
      });
    };

    // A small bold grey caption above a field.
    Dialog.prototype._caption = function (parent, x, y, w, text) {
      parent.addMorph(UI.label(lively.rect(x, y, w, 18), text, { px: 12, bold: true, color: UI.MUTED }));
    };

    // A line of grey help text (single line unless `lines` > 1).
    Dialog.prototype._note = function (parent, x, y, w, text, lines, color) {
      parent.addMorph(UI.label(lively.rect(x, y, w, 18 * (lines || 1) + 2), text, { px: 11, color: color || UI.MUTED, wrap: (lines || 1) > 1 }));
    };

    // A badge drawn at (x, y) inside `parent`. The ring of a stamp is written on the real node once
    // the whole tree is in the world.
    Dialog.prototype._badgeAt = function (parent, badge, x, y, maxW) {
      var p = HB.plan(badge, maxW);
      var m = HB.make(p, x(p), y(p));
      parent.addMorph(m);
      this._later(function () { HB.finish(m); });
      return p;
    };

    // A row of choice chips (agencies, leagues) that wraps. Returns the y below the last row.
    Dialog.prototype._chips = function (panel, y, items, selectedKey, onPick) {
      var self = this, iw = this.W - 2 * PAD, x = 0;
      items.forEach(function (it) {
        var w = Math.ceil(HB.measure(it.label, 12, 700)) + 32;
        if (x > 0 && x + w > iw) { x = 0; y += 38; }
        self._pill(panel, PAD + x, y, it.label, { primary: selectedKey === it.key, w: w, h: 30, onClick: function () { onPick(it.key); } });
        x += w + 8;
      });
      return y + 30;
    };

    // A scrolling list of rows inside this.dyn (at its top). items: [{ id, text, sub, dot, icon }].
    // `selectedId` is drawn chosen. Returns the list's height.
    Dialog.prototype._list = function (items, selectedId, onPick, emptyText) {
      var self = this, iw = this.W - 2 * PAD;
      var h = LIST_ROWS * ROW + 8;
      var box = new lively.morphic.Box(lively.rect(PAD, 0, iw, h));
      box.applyStyle({ fill: UI.PAGE_FILL, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 10, clipMode: "auto" });
      UI.noDrag(box);
      var rowW = iw - 8 - 14;
      if (!items.length) {
        box.addMorph(UI.label(lively.rect(12, 10, rowW - 8, 40), emptyText || "Nothing matches.", { px: 12, color: UI.MUTED, wrap: true }));
      }
      items.forEach(function (it, i) {
        var on = it.id === selectedId;
        var r = new lively.morphic.Box(lively.rect(4, 4 + i * ROW, rowW, ROW));
        r.applyStyle({ fill: on ? UI.PINK_SOFT : null, borderWidth: 0, borderRadius: 8, handStyle: "pointer" });
        UI.noDrag(r);
        var tx = 12;
        if (it.dot) {
          var d = new lively.morphic.Box(lively.rect(12, 12, 10, 10));
          d.applyStyle({ fill: Cat.rgb(it.dot), borderRadius: 5, borderWidth: 0 });
          UI.noDrag(d);
          d.eventsAreIgnored = true;
          r.addMorph(d);
          tx = 32;
        } else if (it.icon) {
          r.addMorph(UI.icon(lively.rect(8, 7, 20, 20), it.icon, 16, UI.PINK));
          tx = 32;
        }
        var subW = it.sub ? Math.ceil(HB.measure(it.sub, 11, 400)) + 16 : 0;
        r.addMorph(UI.label(lively.rect(tx, 7, rowW - tx - subW - (on ? 30 : 8), 20), UI.trunc(it.text, 44), { px: 13, bold: true, color: it.icon ? UI.PINK : UI.INK }));
        if (it.sub) r.addMorph(UI.label(lively.rect(rowW - subW - (on ? 30 : 8), 9, subW, 18), it.sub, { px: 11, color: UI.MUTED, align: "right" }));
        if (on) r.addMorph(UI.icon(lively.rect(rowW - 28, 7, 20, 20), "check", 16, UI.PINK));
        r.onMouseOver = function () { if (!on) r.renderContext().shapeNode.style.background = "rgb(246,243,250)"; };
        r.onMouseOut = function () { if (!on) r.renderContext().shapeNode.style.background = ""; };
        r.onMouseUp = function (evt) { evt.stop(); onPick(it); return true; };
        box.addMorph(r);
        self._kbd(r, it.text, function () { onPick(it); });
      });
      this.dyn.addMorph(box);
      this._later(function () { UI.scroller(box); });
      return h;
    };

    // ─── step 1: the kind tiles ───────────────────────────────────────────────

    Dialog.prototype._renderKinds = function (panel) {
      var self = this, W = this.W, iw = W - 2 * PAD, y = 20, TILE_H = 60;
      panel.addMorph(UI.label(lively.rect(PAD, y, iw, 24), "Add a badge", { px: 16, bold: true }));
      y += 28;
      panel.addMorph(UI.label(lively.rect(PAD, y, iw, 18), "What do you want to show on your homestar?", { px: 12, color: UI.MUTED }));
      y += 30;

      KINDS.forEach(function (k) {
        var tile = new lively.morphic.Box(lively.rect(PAD, y, iw, TILE_H));
        tile.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 12, handStyle: "pointer" });
        UI.noDrag(tile);
        // The sample goes on the right; the title and what it is for on the left.
        var sampleMax = Math.min(210, Math.floor(iw * 0.5));
        var sample = k.sample();
        var p = HB.plan(sample, sampleMax);
        var textW = iw - 32 - p.w - 12;
        tile.addMorph(UI.label(lively.rect(16, 11, textW, 20), k.title, { px: 13, bold: true }));
        tile.addMorph(UI.label(lively.rect(16, 33, textW, 18), k.desc, { px: 11, color: UI.MUTED }));
        var m = HB.make(p, iw - 16 - p.w - 1, Math.round((TILE_H - 2 - p.h) / 2));
        tile.addMorph(m);
        self._later(function () { HB.finish(m); });
        tile.onMouseOver = function () { tile.renderContext().shapeNode.style.background = "rgb(251,248,253)"; };
        tile.onMouseOut = function () { tile.renderContext().shapeNode.style.background = ""; };
        tile.onMouseUp = function (evt) { evt.stop(); self._choose(k.key); return true; };
        panel.addMorph(tile);
        self._kbd(tile, k.title, function () { self._choose(k.key); });
        y += TILE_H + 8;
      });

      y += 6;
      this._pill(panel, W - PAD - 92, y, "Cancel", { primary: false, w: 92, onClick: function () { self.close(); } });
      return y + 30 + 22;
    };

    Dialog.prototype._choose = function (key) {
      this.kind = key;
      this.step = "form";
      this.f = freshState();
      this.error = null;
      this._focusFirst = true;
      this.render();
    };

    Dialog.prototype._back = function () {
      this.step = "kind";
      this.kind = null;
      this.error = null;
      this.render();
    };

    // ─── step 2: what the fields say, as a badge ──────────────────────────────

    // The badge the fields describe, or a short hint for what is missing:
    // { badge } or { hint }. Mirrors the server's rules (core/servers/identity/Badges.js).
    Dialog.prototype._draft = function () {
      var f = this.f, kind = this.kind, base = { id: this.id, kind: kind, visibility: this.visibility };
      var capped = kind !== "place" && this.existing.length >= MAX_BADGES;
      if (capped) return { hint: "You already have " + MAX_BADGES + " badges. Remove one to add another." };
      var out;
      switch (kind) {
        case "place": {
          var label = clean(f.place, 40);
          if (!label) return { hint: "Type a place to continue." };
          out = { label: label };
          break;
        }
        case "transit": {
          if (f.agencyKey !== "other") {
            var A = agencyOf(f.agencyKey);
            if (f.pick == null) return { hint: "Pick a line, or the agency alone." };
            if (f.pick === AGENCY_ONLY) { out = { agency: A.label, label: "", color: A.color, textColor: A.textColor }; break; }
            var L = A.lines.filter(function (l) { return l.label === f.pick; })[0];
            if (!L) return { hint: "Pick a line, or the agency alone." };
            out = { agency: A.label, label: L.label, color: L.color, textColor: L.textColor };
            break;
          }
          var agency = clean(f.agency, 24), line = clean(f.line, 24);
          if (!agency && !line) return { hint: "Type an agency, a line, or both." };
          if (!Cat.isHex(f.color)) return { hint: f.hexBad ? "That is not a colour. Use six digits like #1A4FA0." : "Pick a colour." };
          out = { agency: agency, label: line, color: f.color, textColor: Cat.textColorFor(f.color) };
          break;
        }
        case "school": {
          if (!f.custom) {
            var S = Cat.SCHOOLS.filter(function (s) { return s.name === f.pick; })[0];
            if (!S) return { hint: "Pick one from the list, or add your own." };
            out = { label: S.name, color: S.color, textColor: S.textColor };
            break;
          }
          var sname = clean(f.name, 40);
          if (!sname) return { hint: "Type a name to continue." };
          if (!Cat.isHex(f.color)) return { hint: f.hexBad ? "That is not a colour. Use six digits like #1A4FA0." : "Pick a colour." };
          out = { label: sname, color: f.color, textColor: Cat.textColorFor(f.color) };
          break;
        }
        case "library": {
          var lname = clean(f.name, 40), labbr = cleanAbbr(f.abbr, 4);
          if (!lname) return { hint: "Type the library's name." };
          if (!labbr) return { hint: "Type 1 to 4 letters for the stamp." };
          out = { label: lname, abbr: labbr };
          break;
        }
        case "team": {
          if (!f.custom) {
            var T = Cat.TEAMS.filter(function (t) { return t.name === f.pick; })[0];
            if (!T) return { hint: "Pick a team from the list, or add your own." };
            out = { label: T.name, abbr: T.abbr, color: T.color, textColor: T.textColor };
            break;
          }
          var tname = clean(f.name, 40), tabbr = cleanAbbr(f.abbr, 3);
          if (!tname) return { hint: "Type the team's name." };
          if (!tabbr) return { hint: "Type 1 to 3 letters for the crest." };
          if (!Cat.isHex(f.color)) return { hint: f.hexBad ? "That is not a colour. Use six digits like #1A4FA0." : "Pick a colour." };
          out = { label: tname, abbr: tabbr, color: f.color, textColor: Cat.textColorFor(f.color) };
          break;
        }
      }
      for (var k in out) base[k] = out[k];
      return { badge: base };
    };

    // Redraws what depends on the fields: the preview, the list or colour block, the footer.
    Dialog.prototype._refresh = function () {
      this.error = null;
      this._fillPreview();
      this._fillDyn();
      this._fillFooter();
    };

    Dialog.prototype._clear = function (parent) {
      parent.submorphs.slice().forEach(function (m) { m.remove(); });
    };

    Dialog.prototype._fillPreview = function () {
      var box = this.previewBox, iw = this.W - 2 * PAD;
      if (!box) return;
      this._clear(box);
      box.addMorph(UI.label(lively.rect(12, 5, 120, 16), "Preview", { px: 10, bold: true, color: UI.MUTED }));
      var d = this._draft();
      if (!d.badge) {
        box.addMorph(UI.label(lively.rect(0, 30, iw - 2, 18), "Your badge will appear here", { px: 12, color: UI.MUTED, align: "center" }));
        return;
      }
      this._badgeAt(box, d.badge,
        function (p) { return Math.round((iw - 2 - p.w) / 2); },
        function (p) { return Math.round((PREVIEW_H - 2 - p.h) / 2) + 6; },
        iw - 32);
    };

    Dialog.prototype._fillDyn = function () {
      if (!this.dyn || !this._dynFn) return;
      this._clear(this.dyn);
      this._dynFn.call(this);
    };

    // Back / Cancel / Add badge, and above them the error or what is still missing. Rebuilt on every
    // refresh because Add switches between disabled and ready as the fields change.
    Dialog.prototype._fillFooter = function () {
      var self = this, slot = this.footerSlot, W = this.W, iw = W - 2 * PAD;
      if (!slot) return;
      this._clear(slot);
      var d = this._draft();
      var msg = this.error || d.hint || "";
      if (msg) slot.addMorph(UI.label(lively.rect(PAD, 0, iw, 36), msg, { px: 12, bold: !!this.error, color: this.error ? UI.PINK : UI.MUTED, wrap: true }));
      var y = 40;
      this._pill(slot, PAD, y, "Back", { primary: false, w: 80, onClick: function () { self._back(); } });
      this._pill(slot, W - PAD - 118 - 8 - 92, y, "Cancel", { primary: false, w: 92, onClick: function () { self.close(); } });
      this._pill(slot, W - PAD - 118, y, this.busy ? "Saving…" : "Add badge", {
        primary: true, w: 118, disabled: !d.badge || this.busy, onClick: function () { self._save(); },
      });
    };

    Dialog.prototype._renderForm = function (panel) {
      var self = this, W = this.W, iw = W - 2 * PAD, y = 20;
      panel.addMorph(UI.label(lively.rect(PAD, y, iw, 24), kindOf(this.kind).formTitle, { px: 16, bold: true }));
      y += 32;

      var pv = this.previewBox = new lively.morphic.Box(lively.rect(PAD, y, iw, PREVIEW_H));
      pv.applyStyle({ fill: UI.PAGE_FILL, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 12, clipMode: "hidden" });
      UI.noDrag(pv);
      panel.addMorph(pv);
      y += PREVIEW_H + 16;

      y = this["_form_" + this.kind](panel, y, iw);

      this._caption(panel, PAD, y, iw, "Who can see this badge");
      y += 24;
      var gap = 8, n = VISIBILITIES.length, pw = Math.floor((iw - (n - 1) * gap) / n);
      VISIBILITIES.forEach(function (v, i) {
        self._pill(panel, PAD + i * (pw + gap), y, v.text, {
          primary: self.visibility === v.key, w: pw,
          onClick: function () { self.visibility = v.key; self.render(); },
        });
      });
      y += 38;
      var desc = VISIBILITIES.filter(function (v) { return v.key === self.visibility; })[0].desc;
      this._note(panel, PAD, y, iw, desc, 1);
      y += 30;

      var slot = this.footerSlot = new lively.morphic.Box(lively.rect(0, y, W, 72));
      slot.applyStyle({ fill: null, borderWidth: 0, clipMode: "visible" });
      UI.noDrag(slot);
      panel.addMorph(slot);

      this._fillPreview();
      this._fillDyn();
      this._fillFooter();
      return y + 72 + 14;
    };

    // The area under the fields that changes as you type. `fn` fills it (it is emptied first).
    Dialog.prototype._dynArea = function (panel, y, h, fn) {
      var dyn = this.dyn = new lively.morphic.Box(lively.rect(0, y, this.W, h));
      dyn.applyStyle({ fill: null, borderWidth: 0, clipMode: "visible" });
      UI.noDrag(dyn);
      panel.addMorph(dyn);
      this._dynFn = fn;
      return y + h;
    };

    // The text a field's `Enter` does: save when the badge is complete.
    Dialog.prototype._enter = function () {
      if (this._draft().badge) this._save();
    };

    // ─── step 2, per kind ─────────────────────────────────────────────────────

    // Place: one text field, with city suggestions from the same list the old profile field used.
    Dialog.prototype._form_place = function (panel, y, iw) {
      var self = this, f = this.f;
      this._caption(panel, PAD, y, iw, "Place");
      y += 22;
      this._input({ x: PAD, y: y, w: iw, value: f.place, max: 40, aria: "Place", placeholder: "For example: Oakland, CA or THE BAY",
        onInput: function (v) { f.place = v; f.pickedCity = null; self._refresh(); }, onEnter: function () { self._enter(); } });
      y += 46;
      // The place the page shows now, real or the old public profile location read through as one.
      var old = (this.opts.badges || []).filter(function (b) { return b && b.kind === "place"; })[0];
      var note = old
        ? "This replaces “" + UI.trunc(old.label, 30) + "”."
        : "Type anything you like. Cities are suggested as you type.";
      this._note(panel, PAD, y, iw, note, 1);
      y += 24;
      this._later(function () {
        lively.identity.NatalChart.ensureLoaded(function (err) {
          if (!err && self.scrim && self.kind === "place") self._fillDyn();
        });
      });
      return this._dynArea(panel, y, 5 * 30 + 8, function () {
        var typed = clean(f.place, 40);
        var cities = typed.length >= 2 && f.pickedCity !== typed ? lively.identity.NatalChart.searchCities(typed, 5) : [];
        var iwid = self.W - 2 * PAD;
        cities.forEach(function (c, i) {
          var r = new lively.morphic.Box(lively.rect(PAD, i * 30, iwid, 30));
          r.applyStyle({ fill: null, borderWidth: 0, borderRadius: 8, handStyle: "pointer" });
          UI.noDrag(r);
          r.addMorph(UI.icon(lively.rect(6, 5, 20, 20), "location_on", 15, UI.MUTED));
          r.addMorph(UI.label(lively.rect(32, 5, iwid - 40, 20), UI.trunc(lively.identity.NatalChart.cityLabel(c), 48), { px: 13 }));
          var pickIt = function () {
            f.place = c.name.slice(0, 40);
            f.pickedCity = clean(f.place, 40);
            if (self._inputs[0]) { self._inputs[0].value = f.place; self._inputs[0].focus(); }
            self._refresh();
          };
          r.onMouseOver = function () { r.renderContext().shapeNode.style.background = "rgb(246,243,250)"; };
          r.onMouseOut = function () { r.renderContext().shapeNode.style.background = ""; };
          r.onMouseUp = function (evt) { evt.stop(); pickIt(); return true; };
          self.dyn.addMorph(r);
          self._kbd(r, lively.identity.NatalChart.cityLabel(c), pickIt);
        });
      });
    };

    // Transit: an agency from the catalog and one of its lines, or "Other" with your own names and colour.
    Dialog.prototype._form_transit = function (panel, y, iw) {
      var self = this, f = this.f;
      this._caption(panel, PAD, y, iw, "Agency");
      y += 22;
      var chips = Cat.AGENCIES.map(function (a) { return { key: a.key, label: a.label }; }).concat([{ key: "other", label: "Other" }]);
      y = this._chips(panel, y, chips, f.agencyKey, function (key) {
        f.agencyKey = key; f.pick = null; f.query = ""; f.color = null; f.hexText = ""; f.hexBad = false;
        self._focusFirst = true;
        self.render();
      });
      y += 16;

      if (f.agencyKey !== "other") {
        var A = agencyOf(f.agencyKey);
        this._caption(panel, PAD, y, iw, "Line or route");
        y += 22;
        this._input({ x: PAD, y: y, w: iw, value: f.query, max: 24, aria: "Search " + A.label + " lines", placeholder: "Search " + A.label + " lines",
          onInput: function (v) { f.query = v; self._refresh(); }, onEnter: function () { self._enter(); } });
        y += 46;
        return this._dynArea(panel, y, LIST_ROWS * ROW + 8 + 14, function () {
          var q = f.query.trim().toLowerCase();
          var items = [];
          if (A.color && (!q || A.label.toLowerCase().indexOf(q) !== -1)) items.push({ id: AGENCY_ONLY, text: "Just “" + A.label + "”", sub: "no line", dot: A.color });
          A.lines.filter(function (l) { return !q || l.label.toLowerCase().indexOf(q) !== -1; })
            .forEach(function (l) { items.push({ id: l.label, text: l.label, dot: l.color }); });
          self._list(items, f.pick, function (it) { f.pick = it.id; self._refresh(); },
            "No line matches. Choose “Other” to type your own.");
        });
      }

      // Other: free agency and line, then a colour.
      var half = Math.floor((iw - 8) / 2);
      this._caption(panel, PAD, y, half, "Agency");
      this._caption(panel, PAD + half + 8, y, half, "Line or route");
      y += 22;
      this._input({ x: PAD, y: y, w: half, value: f.agency, max: 24, aria: "Agency", placeholder: "For example: Metro",
        onInput: function (v) { f.agency = v; self._refresh(); }, onEnter: function () { self._enter(); } });
      this._input({ x: PAD + half + 8, y: y, w: half, value: f.line, max: 24, aria: "Line or route", placeholder: "For example: 72 or Harbor Line",
        onInput: function (v) { f.line = v; self._refresh(); }, onEnter: function () { self._enter(); } });
      y += 52;
      return this._colorBlock(panel, y, iw);
    };

    // School or community: a catalog list with search, then "add your own" with a name and a colour.
    Dialog.prototype._form_school = function (panel, y, iw) {
      var self = this, f = this.f;
      if (f.custom) {
        y = this._backToList(panel, y, iw, "Choose from the list");
        this._caption(panel, PAD, y, iw, "Name");
        y += 22;
        this._input({ x: PAD, y: y, w: iw, value: f.name, max: 40, aria: "School or community name", placeholder: "For example: Laney College",
          onInput: function (v) { f.name = v; self._refresh(); }, onEnter: function () { self._enter(); } });
        y += 52;
        return this._colorBlock(panel, y, iw);
      }
      this._caption(panel, PAD, y, iw, "School or community");
      y += 22;
      this._input({ x: PAD, y: y, w: iw, value: f.query, max: 40, aria: "Search schools and communities", placeholder: "Search, or type your own name",
        onInput: function (v) { f.query = v; self._refresh(); }, onEnter: function () { self._enter(); } });
      y += 46;
      return this._dynArea(panel, y, LIST_ROWS * ROW + 8 + 14, function () {
        var q = f.query.trim().toLowerCase();
        var items = Cat.SCHOOLS.filter(function (s) { return !q || s.name.toLowerCase().indexOf(q) !== -1; })
          .map(function (s) { return { id: s.name, text: s.name, dot: s.color }; });
        items.push({ id: CUSTOM_ROW, icon: "add", text: q ? "Use “" + clean(f.query, 24) + "” as my own" : "Add one that is not listed" });
        self._list(items, f.pick, function (it) {
          if (it.id === CUSTOM_ROW) { f.custom = true; f.name = clean(f.query, 40); f.color = null; f.hexText = ""; f.hexBad = false; self._focusFirst = true; self.render(); return; }
          f.pick = it.id;
          self._refresh();
        });
      });
    };

    // Library: a name and a 1-4 letter abbreviation for the stamp (guessed from the name until you type one).
    Dialog.prototype._form_library = function (panel, y, iw) {
      var self = this, f = this.f;
      var abW = 128, nameW = iw - abW - 8;
      this._caption(panel, PAD, y, nameW, "Library name");
      this._caption(panel, PAD + nameW + 8, y, abW, "Stamp letters");
      y += 22;
      this._input({ x: PAD, y: y, w: nameW, value: f.name, max: 40, aria: "Library name", placeholder: "For example: Oakland Public Library",
        onInput: function (v) {
          f.name = v;
          if (!f.abbrTouched) {
            f.abbr = initials(v, 4);
            if (self._inputs[1]) self._inputs[1].value = f.abbr;
          }
          self._refresh();
        }, onEnter: function () { self._enter(); } });
      this._input({ x: PAD + nameW + 8, y: y, w: abW, value: f.abbr, max: 4, aria: "Stamp letters", placeholder: "OPL",
        onInput: function (v, input) {
          f.abbr = cleanAbbr(v, 4);
          f.abbrTouched = true;
          if (input.value !== f.abbr) input.value = f.abbr;
          self._refresh();
        }, onEnter: function () { self._enter(); } });
      y += 46;
      this._note(panel, PAD, y, iw, "The stamp shows the letters; hovering it shows the full name.", 1);
      return y + 34;
    };

    // Team: league chips, a search, the catalog list, then "add your own" with name, crest letters and colour.
    Dialog.prototype._form_team = function (panel, y, iw) {
      var self = this, f = this.f;
      if (f.custom) {
        y = this._backToList(panel, y, iw, "Choose from the list");
        var abW = 128, nameW = iw - abW - 8;
        this._caption(panel, PAD, y, nameW, "Team name");
        this._caption(panel, PAD + nameW + 8, y, abW, "Crest letters");
        y += 22;
        this._input({ x: PAD, y: y, w: nameW, value: f.name, max: 40, aria: "Team name", placeholder: "For example: Oakland Roots",
          onInput: function (v) {
            f.name = v;
            if (!f.abbrTouched) { f.abbr = initials(v, 3); if (self._inputs[1]) self._inputs[1].value = f.abbr; }
            self._refresh();
          }, onEnter: function () { self._enter(); } });
        this._input({ x: PAD + nameW + 8, y: y, w: abW, value: f.abbr, max: 3, aria: "Crest letters", placeholder: "ORS",
          onInput: function (v, input) {
            f.abbr = cleanAbbr(v, 3);
            f.abbrTouched = true;
            if (input.value !== f.abbr) input.value = f.abbr;
            self._refresh();
          }, onEnter: function () { self._enter(); } });
        y += 52;
        return this._colorBlock(panel, y, iw);
      }
      this._caption(panel, PAD, y, iw, "League");
      y += 22;
      var leagues = ["All"];
      Cat.TEAMS.forEach(function (t) { if (leagues.indexOf(t.league) === -1) leagues.push(t.league); });
      y = this._chips(panel, y, leagues.map(function (l) { return { key: l, label: l }; }), f.league, function (key) {
        f.league = key;
        self._focusFirst = true;
        self.render();
      });
      y += 14;
      this._caption(panel, PAD, y, iw, "Team");
      y += 22;
      this._input({ x: PAD, y: y, w: iw, value: f.query, max: 40, aria: "Search teams", placeholder: "Search, or type your own team's name",
        onInput: function (v) { f.query = v; self._refresh(); }, onEnter: function () { self._enter(); } });
      y += 46;
      return this._dynArea(panel, y, LIST_ROWS * ROW + 8 + 14, function () {
        var q = f.query.trim().toLowerCase();
        var items = Cat.TEAMS.filter(function (t) {
          if (f.league !== "All" && t.league !== f.league) return false;
          return !q || (t.name + " " + t.full + " " + t.abbr).toLowerCase().indexOf(q) !== -1;
        }).map(function (t) { return { id: t.name, text: t.name, sub: t.full === t.name ? t.league : t.full, dot: t.color }; });
        items.push({ id: CUSTOM_ROW, icon: "add", text: q ? "Use “" + clean(f.query, 24) + "” as a custom team name" : "Add a team that is not listed" });
        self._list(items, f.pick, function (it) {
          if (it.id === CUSTOM_ROW) {
            f.custom = true; f.name = clean(f.query, 40); f.abbr = initials(f.name, 3); f.abbrTouched = false;
            f.color = null; f.hexText = ""; f.hexBad = false;
            self._focusFirst = true;
            self.render();
            return;
          }
          f.pick = it.id;
          self._refresh();
        });
      });
    };

    // A small "<- Choose from the list" link row at the top of a custom form.
    Dialog.prototype._backToList = function (panel, y, iw, text) {
      var self = this, f = this.f;
      var w = Math.ceil(HB.measure(text, 12, 700)) + 44;
      var back = UI.pill(PAD, y, text, { primary: false, w: w, h: 28, onClick: function () { f.custom = false; f.hexBad = false; self._focusFirst = true; self.render(); } });
      panel.addMorph(back);
      this._kbd(back, text, function () { f.custom = false; f.hexBad = false; self._focusFirst = true; self.render(); });
      return y + 28 + 14;
    };

    // The colour part of a custom badge: twelve fills to pick from, or a hex of your own. The text colour
    // is worked out (white, ink or black, whichever reaches 4.5:1), so the owner never picks an unreadable
    // pair. The swatches are the "dynamic" part (the chosen one is marked); the hex field is a native input.
    Dialog.prototype._colorBlock = function (panel, y, iw) {
      var self = this, f = this.f;
      var per = Math.max(1, Math.floor((iw + 8) / 36)), rows = Math.ceil(SWATCHES.length / per);
      this._caption(panel, PAD, y, iw, "Colour");
      y += 22;
      var swatchH = rows * 36;
      var dynH = swatchH + 6 + 38 + 20;       // the same air under it as under every other field
      var hexY = y + swatchH + 6;
      this._input({ x: PAD, y: hexY, w: 120, value: f.hexText, max: 7, aria: "Hex colour", placeholder: "#1A4FA0",
        onInput: function (v) {
          f.hexText = v;
          var hex = parseHex(v);
          f.color = hex;
          f.hexBad = !hex && v.trim() !== "";
          self._refresh();
        }, onEnter: function () { self._enter(); } });
      return this._dynArea(panel, y, dynH, function () {
        SWATCHES.forEach(function (hex, i) {
          var on = f.color === hex;
          var s = new lively.morphic.Box(lively.rect(PAD + (i % per) * 36, Math.floor(i / per) * 36, 28, 28));
          s.applyStyle({ fill: Cat.rgb(hex), borderRadius: 14, borderWidth: 0, handStyle: "pointer" });
          UI.noDrag(s);
          if (on) s.addMorph(UI.icon(lively.rect(4, 4, 20, 20), "check", 16, Cat.rgb(Cat.textColorFor(hex) || "#FFFFFF")));
          var pickIt = function () {
            f.color = hex; f.hexText = hex; f.hexBad = false;
            if (self._inputs.length) self._inputs[self._inputs.length - 1].value = hex;
            self._refresh();
          };
          s.onMouseUp = function (evt) { evt.stop(); pickIt(); return true; };
          self.dyn.addMorph(s);
          self._kbd(s, "Colour " + hex, pickIt);
        });
        var msg = f.hexBad ? "Use six digits or letters, like #1A4FA0." : "Or type a hex colour. The text colour is chosen so it stays readable.";
        self.dyn.addMorph(UI.label(lively.rect(PAD + 132, swatchH + 6 + 10, iw - 132, 20), msg, { px: 11, color: f.hexBad ? UI.PINK : UI.MUTED }));
      });
    };

    // ─── saving ───────────────────────────────────────────────────────────────

    Dialog.prototype._save = function () {
      var self = this, d = this._draft();
      if (!d.badge || this.busy) return;
      var badge = d.badge;
      this.busy = true;
      this.error = null;
      this._fillFooter();
      lively.identity.postcardAudience.patchSettings(function (state) {
        var list = Array.isArray(state.badges) ? state.badges.slice() : [];
        // There is only one place: a new one replaces the old, and it goes first.
        if (badge.kind === "place") { list = list.filter(function (b) { return b.kind !== "place"; }); list.unshift(badge); }
        else list.push(badge);
        state.badges = list;
      }, function (err) {
        if (err) {
          self.busy = false;
          self.error = "Could not save: " + ((err && err.message) || err);
          if (self.scrim) self._fillFooter();
          return;
        }
        var old = String(self.opts.oldLocation || "").trim();
        if (badge.kind !== "place" || !old) return self._done({});
        // The old public location must go too, or a Friends-only place would still be readable by anyone.
        lively.require("lively.identity.UserSpace").toRun(function () {
          lively.identity.userSpace.saveProfile({ location: "" }, function (err2) {
            if (!err2) return self._done({ locationCleared: true });
            self._done({});
            $world.alert("Your place is saved, but the old public location could not be removed: " + ((err2 && err2.message) || err2));
          });
        });
      });
    };

    Dialog.prototype._done = function (info) {
      this.busy = false;
      this.close();
      if (this.opts.onSave) this.opts.onSave(info);
    };

    lively.identity.BadgePicker = {
      open: function (opts) { return new Dialog(opts || {}).open(); },
      // Exposed for the tests.
      initials: initials,
      cleanAbbr: cleanAbbr,
      parseHex: parseHex,
    };

  }); // end module('lively.identity.BadgePicker')
