/**
 * lively.identity.EditEventDialog
 *
 * Create/edit dialog for a constellation's upcoming-event card
 * (ConstellationLounge.js's Quick Info panel, _renderEventCard /
 * _renderEmptyEventCard) — opened from the pencil icon on a populated card
 * or the "add" icon on the empty-state card, both controller-only (this
 * dialog is only ever reached by one, but the PUT/POST routes it calls
 * re-check isController server-side regardless, same division of
 * responsibility as ConstellationSettingsDialog.js).
 *
 * Only title/startsAt/location are editable here — attendeeCount/attendees
 * are derived from constellation members' own RSVP responses (see the
 * Going/Maybe/Not-going row on the card itself, ConstellationLounge.js's
 * _renderEventCard) and are never set manually. "Starts at" is a mini
 * month-calendar date picker (ported from core/lively/calendar/
 * CalendarApp.js's own _renderMiniCalendar) plus a plain HH:MM time field,
 * rather than a raw ISO-with-offset text field — the picker always works
 * in whoever is editing's own local wall-clock time (see _toIsoWithOffset).
 *
 * Open: lively.identity.EditEventDialog.open(name, event, onSaved)
 *   event: null (create mode) or { id, title, startsAt, location } (edit mode)
 */

module("lively.identity.EditEventDialog")
  .requires(
    "lively.identity.DID",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    lively.BuildSpec("lively.identity.EditEventDialog", {
      _BorderRadius: 7,
      _Extent: lively.pt(480, 330),
      _Fill: Color.rgb(251, 86, 213),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "EditEventDialog",
      titleBar: "Event",
      submorphs: [
        {
          _BorderColor: Color.rgb(95, 94, 95),
          _BorderRadius: 4,
          _BorderWidth: 1,
          _Extent: lively.pt(474, 305),
          _Fill: Color.rgb(243, 243, 243),
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          clipMode: "auto",
          layout: { adjustForNewBounds: true, resizeWidth: true, resizeHeight: true },
          name: "eventContent",
          submorphs: [],
        },
      ],

      connectionRebuilder: function connectionRebuilder() {
        lively.bindings.connect(this, "remove", this, "onRemove", {});
      },

      // ─── lifecycle ────────────────────────────────────────────────────────

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        $super();
        this._constellationName = null;
        this._eventId = null;
        this._onSaved = null;
      },

      onRemove: function onRemove() {},

      // Builds an ISO 8601 string with the LOCAL UTC offset baked in (e.g.
      // "2026-12-03T18:00:00-06:00") from a plain JS Date holding the
      // desired wall-clock time in the current browser's own timezone —
      // matches the format ConstellationLounge.js's _formatEventDateTime
      // parses back out for display. getTimezoneOffset() returns minutes
      // WEST of UTC (positive when behind UTC, e.g. 360 for "-06:00") —
      // the opposite sign convention from the offset string itself, hence
      // the leading negation. No outer closure dependency (own inline
      // pad2, only real globals otherwise) — safe as a spec-level method
      // per CLAUDE.md's BuildSpec-closure-loss gotcha.
      _toIsoWithOffset: function _toIsoWithOffset(date) {
        function pad2(n) { return (n < 10 ? "0" : "") + n; }
        var offMin = -date.getTimezoneOffset();
        var sign = offMin >= 0 ? "+" : "-";
        var absMin = Math.abs(offMin);
        var offStr = sign + pad2(Math.floor(absMin / 60)) + ":" + pad2(absMin % 60);
        return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate()) +
          "T" + pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":00" + offStr;
      },

      // Called by the static open() below. event is null for create mode.
      // _pickerSelectedDate/_pickerMonthView/_timeStr seed the mini
      // calendar + time field — in edit mode, event.startsAt (an ISO
      // string with its OWN embedded offset) is reinterpreted via
      // `new Date(...)` into whichever timezone the editing browser is
      // currently in (an intentional behavior change from the old raw-text
      // field, which preserved the original offset verbatim — this matches
      // how every ordinary calendar UI displays times, and nothing else in
      // this codebase depends on the literal offset substring surviving an
      // edit unchanged).
      load: function load(name, event, onSaved) {
        this._constellationName = name;
        this._eventId = (event && event.id) || null;
        this._title = (event && event.title) || "";
        this._location = (event && event.location) || "";
        var initialDate = (event && event.startsAt) ? new Date(event.startsAt) : new Date();
        if (isNaN(initialDate.getTime())) initialDate = new Date();
        this._pickerSelectedDate = new Date(initialDate.getFullYear(), initialDate.getMonth(), initialDate.getDate());
        this._pickerMonthView = new Date(initialDate.getFullYear(), initialDate.getMonth(), 1);
        function pad2(n) { return (n < 10 ? "0" : "") + n; }
        this._timeStr = pad2(initialDate.getHours()) + ":" + pad2(initialDate.getMinutes());
        this._onSaved = onSaved || function () {};
        this.setTitle(this._eventId ? "Edit Event" : "New Event");
        this._render();
      },

      // ─── render ─────────────────────────────────────────────────────────────

      _render: function _render() {
        var self = this;
        var content = this.get("eventContent");
        content.removeAllMorphs();
        var MARGIN = 18;
        var ew = 438;
        var y = 18;

        function sectionLabel(str) {
          var lbl = new lively.morphic.Text(lively.rect(MARGIN, y, ew, 16), str);
          lbl.applyStyle({ allowInput: false, fontSize: 12, fontWeight: "bold",
            textColor: Color.rgb(80, 80, 80),
            fill: null, borderWidth: 0 });
          content.addMorph(lbl);
          y += 22;
        }

        function fieldLabel(str) {
          var lbl = new lively.morphic.Text(lively.rect(MARGIN, y, ew, 14), str);
          lbl.applyStyle({ allowInput: false, fontSize: 10,
            textColor: Color.rgb(140, 140, 140),
            fill: null, borderWidth: 0 });
          content.addMorph(lbl);
          y += 17;
        }

        // Same idiom as ConstellationSettingsDialog.js's styledButton — one
        // local copy per dialog, no shared module exports these helpers.
        function styledButton(rect, label, variant) {
          var palette = {
            "default": { fill: Color.rgb(247, 247, 250), hoverFill: Color.rgb(236, 236, 243),
              border: Color.rgb(223, 223, 233), text: Color.rgb(70, 70, 80) },
            "success": { fill: Color.rgb(233, 250, 237), hoverFill: Color.rgb(217, 245, 223),
              border: Color.rgb(179, 224, 191), text: Color.rgb(20, 120, 60) },
          }[variant || "default"];
          var btn = new lively.morphic.Button(rect, label);
          btn.applyStyle({ fill: palette.fill,
            borderColor: palette.border, borderRadius: 8,
            fontSize: 11, textColor: palette.text, borderWidth: 1 });
          btn.setAppearanceStylingMode(false);
          btn.setBorderStylingMode(false);
          btn.onMouseOver = function () { btn.applyStyle({ fill: palette.hoverFill }); };
          btn.onMouseOut = function () { btn.applyStyle({ fill: palette.fill }); };
          return btn;
        }

        // Single-line editable field — same two-step fix as
        // ConstellationSettingsDialog.js's textField: applyStyle AFTER
        // beInputLine() (which can reset style properties), extent
        // re-asserted after both since beInputLine()/hug-content can grow
        // the box past its constructor rect otherwise.
        function textField(name, value) {
          var inp = new lively.morphic.Text(lively.rect(MARGIN, y, ew, 28), value || "");
          inp.name = name;
          inp.beInputLine();
          inp.applyStyle({ allowInput: true, fontSize: 12, clipMode: "hidden",
            fixedWidth: true, fixedHeight: true, whiteSpaceHandling: "pre",
            fill: Color.rgb(252, 252, 252),
            borderColor: Color.rgb(200, 200, 200), borderWidth: 1, borderRadius: 4 });
          inp.setExtent(lively.pt(ew, 28));
          content.addMorph(inp);
          y += 28 + 6;
          return inp;
        }

        function divider() {
          y += 6;
          var line = new lively.morphic.Box(lively.rect(MARGIN, y, ew, 1));
          line.applyStyle({ fill: Color.rgb(228, 228, 228), borderWidth: 0 });
          content.addMorph(line);
          y += 16;
        }

        // ── Title ───────────────────────────────────────────────────────────
        sectionLabel("Title");
        textField("eedTitle", this._title);

        // ── Starts At: mini month-calendar date picker + time field ──────────
        // Grid-building logic ported from CalendarApp.js's own
        // _renderMiniCalendar (same 7-col layout, prev/next month header,
        // click-to-select day), but every date-math helper it needs is
        // declared INSIDE this method body rather than as module-scope
        // `toRun` closures — a lively.BuildSpec method is reconstructed
        // from its own source text at runtime and can only see `this.*`,
        // real globals, or identifiers textually declared in that same
        // method body (CLAUDE.md's BuildSpec-closure-loss gotcha). Day-cell
        // and month-nav clicks mutate self._pickerSelectedDate/
        // _pickerMonthView and call self._render() for a full redraw —
        // the same "mutate state, re-render everything" idiom
        // ConstellationSettingsDialog.js's _addDomain/_removeDomain use.
        sectionLabel("Starts at");
        (function renderDatePicker() {
          function pad2(n) { return (n < 10 ? "0" : "") + n; }
          function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
          function addDays(d, n) { var r = new Date(d.getTime()); r.setDate(r.getDate() + n); return r; }
          function startOfWeek(d) { return addDays(startOfDay(d), -d.getDay()); }
          function isSameDay(a, b) {
            return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
          }
          function isToday(d) { return isSameDay(d, new Date()); }
          var MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"];
          var DOW_SHORT = ["S", "M", "T", "W", "T", "F", "S"];

          var calY = y;
          var CAL_W = 220, CAL_H = 176, CAL_GAP = 18;
          var focusMonth = self._pickerMonthView;
          var selectedDay = self._pickerSelectedDate;

          var calBox = new lively.morphic.Box(lively.rect(MARGIN, calY, CAL_W, CAL_H));
          calBox.applyStyle({ fill: Color.rgb(252, 252, 252), borderWidth: 1,
            borderColor: Color.rgb(200, 200, 200), borderRadius: 4, clipMode: "hidden" });
          content.addMorph(calBox);

          var CELL_W = CAL_W / 7, HEADER_H = 22, DOW_H = 16, CELL_H = 22;

          function navBtn(x, glyph, dir) {
            var b = new lively.morphic.Text(lively.rect(x, 0, 22, HEADER_H), glyph);
            b.applyStyle({ fontFamily: "'Material Symbols Rounded'", fontSize: 12,
              textColor: Color.rgb(90, 90, 90), fill: null, borderWidth: 0, align: "center",
              allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
              handStyle: "pointer" });
            b.draggingEnabled = false; b.droppingEnabled = false; b.grabbingEnabled = false;
            b.onMouseUp = function (evt) {
              self._pickerMonthView = new Date(focusMonth.getFullYear(), focusMonth.getMonth() + dir, 1);
              self._render();
              evt.stop();
              return true;
            };
            return b;
          }
          calBox.addMorph(navBtn(0, "chevron_left", -1));
          var monthLbl = new lively.morphic.Text(lively.rect(22, 0, CAL_W - 44, HEADER_H),
            MONTH_NAMES[focusMonth.getMonth()] + " " + focusMonth.getFullYear());
          monthLbl.applyStyle({ fontSize: 11, fontWeight: "bold", textColor: Color.rgb(60, 60, 60),
            fill: null, borderWidth: 0, align: "center", allowInput: false, selectable: false,
            clipMode: "hidden", whiteSpaceHandling: "pre" });
          calBox.addMorph(monthLbl);
          calBox.addMorph(navBtn(CAL_W - 22, "chevron_right", 1));

          DOW_SHORT.forEach(function (d, i) {
            var dl = new lively.morphic.Text(lively.rect(i * CELL_W, HEADER_H, CELL_W, DOW_H), d);
            dl.applyStyle({ fontSize: 9, textColor: Color.rgb(150, 150, 150), fill: null, borderWidth: 0,
              align: "center", allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre" });
            calBox.addMorph(dl);
          });

          var monthStart = new Date(focusMonth.getFullYear(), focusMonth.getMonth(), 1);
          var gridStart = startOfWeek(monthStart);
          var monthEnd = new Date(focusMonth.getFullYear(), focusMonth.getMonth() + 1, 0);
          var gridEnd = addDays(startOfWeek(monthEnd), 6);
          var numDays = Math.round((gridEnd - gridStart) / 86400000) + 1;
          for (var i = 0; i < numDays; i++) {
            var d = addDays(gridStart, i);
            var col = i % 7, row = Math.floor(i / 7);
            var inMonth = d.getMonth() === focusMonth.getMonth();
            var isSel = isSameDay(d, selectedDay);
            var isTod = isToday(d);
            var cell = new lively.morphic.Box(lively.rect(col * CELL_W, HEADER_H + DOW_H + row * CELL_H, CELL_W, CELL_H));
            cell.applyStyle({ fill: isSel ? Color.rgb(232, 73, 126) : null, borderWidth: 0,
              borderRadius: CELL_H / 2, clipMode: "hidden" });
            cell.draggingEnabled = false; cell.droppingEnabled = false; cell.grabbingEnabled = false;
            var dayLbl = new lively.morphic.Text(lively.rect(0, 3, CELL_W, CELL_H - 6), String(d.getDate()));
            dayLbl.applyStyle({ fontSize: 10, fontWeight: (isTod || isSel) ? "bold" : "normal",
              textColor: isSel ? Color.white : (isTod ? Color.rgb(232, 73, 126) : (inMonth ? Color.rgb(40, 40, 40) : Color.rgb(180, 180, 180))),
              fill: null, borderWidth: 0, align: "center", allowInput: false, selectable: false,
              clipMode: "hidden", whiteSpaceHandling: "pre" });
            dayLbl.eventsAreIgnored = true;
            cell.addMorph(dayLbl);
            cell.onMouseUp = (function (day) {
              return function (evt) {
                self._pickerSelectedDate = day;
                self._pickerMonthView = new Date(day.getFullYear(), day.getMonth(), 1);
                self._render();
                evt.stop();
                return true;
              };
            })(d);
            calBox.addMorph(cell);
          }

          // Selected-date readout + time field, to the right of the grid.
          var timeX = MARGIN + CAL_W + CAL_GAP;
          var timeW = ew - CAL_W - CAL_GAP;
          var selReadout = new lively.morphic.Text(lively.rect(timeX, calY, timeW, 16),
            MONTH_NAMES[selectedDay.getMonth()] + " " + selectedDay.getDate() + ", " + selectedDay.getFullYear());
          selReadout.applyStyle({ allowInput: false, fontSize: 11, fontWeight: "bold",
            textColor: Color.rgb(60, 60, 60), fill: null, borderWidth: 0 });
          content.addMorph(selReadout);

          var timeLblY = calY + 26;
          var timeLbl = new lively.morphic.Text(lively.rect(timeX, timeLblY, timeW, 14), "Time (24h HH:MM)");
          timeLbl.applyStyle({ allowInput: false, fontSize: 10, textColor: Color.rgb(140, 140, 140),
            fill: null, borderWidth: 0 });
          content.addMorph(timeLbl);

          var timeInp = new lively.morphic.Text(lively.rect(timeX, timeLblY + 17, timeW, 28), self._timeStr);
          timeInp.name = "eedTime";
          timeInp.beInputLine();
          timeInp.applyStyle({ allowInput: true, fontSize: 12, clipMode: "hidden",
            fixedWidth: true, fixedHeight: true, whiteSpaceHandling: "pre",
            fill: Color.rgb(252, 252, 252), borderColor: Color.rgb(200, 200, 200), borderWidth: 1, borderRadius: 4 });
          timeInp.setExtent(lively.pt(timeW, 28));
          content.addMorph(timeInp);

          y = calY + CAL_H + 10;
        })();

        // ── Location ────────────────────────────────────────────────────────
        sectionLabel("Location (optional)");
        textField("eedLocation", this._location);

        divider();

        // ── Save ─────────────────────────────────────────────────────────────
        // No separate Cancel button — the window's own title-bar close (X)
        // already discards unsaved changes, same as ConstellationSettingsDialog.js.
        var BTN_W = 96;
        var saveBtn = styledButton(lively.rect(MARGIN + ew - BTN_W, y, BTN_W, 30), "Save", "success");
        saveBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (!win) return;
          win._save(this);
        });
        lively.bindings.connect(saveBtn, "fire", saveBtn, "doAction");
        content.addMorph(saveBtn);
        y += 30 + 18;

        // Grow the window (never shrink it) if content needs more room than
        // it currently has, same idiom as ConstellationSettingsDialog.js.
        var neededHeight = y + (this.contentOffset ? this.contentOffset.y : 22) + 6;
        if (neededHeight > this.getExtent().y) {
          this.setExtent(lively.pt(this.getExtent().x, neededHeight));
        }
      },

      // ─── actions ────────────────────────────────────────────────────────────

      _save: function _save(btn) {
        var self = this;
        var content = this.get("eventContent");
        var title = (content.get("eedTitle") && content.get("eedTitle").textString || "").trim();
        var timeStr = (content.get("eedTime") && content.get("eedTime").textString || "").trim();
        var location = (content.get("eedLocation") && content.get("eedLocation").textString || "").trim();

        if (!title) { alert("Title is required."); return; }
        var m = /^(\d{1,2}):(\d{2})$/.exec(timeStr);
        if (!m || +m[1] > 23 || +m[2] > 59) {
          alert("Time must be in 24-hour HH:MM format, e.g. 18:00.");
          return;
        }
        var d = this._pickerSelectedDate;
        var startsAtDate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), +m[1], +m[2], 0, 0);
        var startsAt = this._toIsoWithOffset(startsAtDate);

        btn.setLabel("Saving…");
        btn.setActive(false);
        var base = lively.identity.did.baseUrl();
        var body = { title: title, startsAt: startsAt, location: location };
        var url, method;
        if (this._eventId) {
          url = base + "/c/" + encodeURIComponent(this._constellationName) + "/events/" + encodeURIComponent(this._eventId);
          method = "PUT";
        } else {
          url = base + "/c/" + encodeURIComponent(this._constellationName) + "/events";
          method = "POST";
        }
        fetch(url, {
          method: method,
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
          .then(function (res) {
            return res.json().then(function (respBody) {
              if (!res.ok) throw new Error(respBody.error || ("HTTP " + res.status));
              self._onSaved();
              self.remove();
            });
          })
          .catch(function (err) {
            alert("Could not save event: " + err.message);
            btn.setLabel("Save");
            btn.setActive(true);
          });
      },
    });

    lively.identity.EditEventDialog = {
      open: function (name, event, onSaved) {
        var win = lively.BuildSpec("lively.identity.EditEventDialog").createMorph();
        win.openInWorldCenter();
        win.load(name, event, onSaved);
        return win;
      },
    };

  });
