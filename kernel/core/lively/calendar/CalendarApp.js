/**
 * lively.calendar.CalendarApp
 *
 * Full morphic (no native DOM) Month/Week/Day calendar, built the same way
 * lively.transit.SearchOverlay/TransitMapMorph are: plain lively.morphic.Box/
 * Text children composed imperatively. Unlike those transient overlays, this
 * whole app is meant to survive "Publish to Inventory" (PartsBin.js's
 * generic promptPublishToInventory halo action, no app-specific publish code
 * needed — see core/lively/commerce/Shop.js, the proven precedent for a
 * stateful app in this identity-aware inventory system).
 *
 * That precedent is also why this is a lively.morphic.Box.subclass rather
 * than a lively.BuildSpec or a tree of addScript'd morphs: subclass methods
 * live on the prototype and are never reconstructed from serialized source
 * text (only BuildSpec/addScript do that, and only BuildSpec's own
 * evalJS path is safe for it — see CLAUDE.md's BuildSpec-closure-loss
 * section), so they're free to close over this file's module-scope
 * constants/helpers exactly like Shop.js's methods close over SHOP_CSS/
 * seedProducts(). Only plain-data instance fields (calendars/events/
 * currentDate/currentView) are persisted; the entire visible submorph tree
 * is torn down and rebuilt from that data every time _setup() runs — on
 * first construction AND after deserialization (prepareForNewRenderContext,
 * same as Shop.js) — so any instance-level closures assigned to freshly
 * built children (event chip click handlers etc.) never need to themselves
 * survive a serialize/deserialize round trip.
 *
 * Entry point: lively.calendar.CalendarApp.open()
 */

module("lively.calendar.CalendarApp")
  .requires(
    "lively.morphic.Core",
    "lively.morphic.TextFormattingSupport",
    "lively.morphic.TextFormattingToolbar",
    "lively.calendar.CalendarImport",
    "lively.identity.DID",
    "lively.identity.PostCardUtils",
  )
  .toRun(function () {

    // ─── layout constants ──────────────────────────────────────────────

    var APP_W = 1180, APP_H = 760;
    var HEADER_H = 60;
    var SIDEBAR_W = 210;
    var MIN_W = 760, MIN_H = 520;

    var HOUR_ROW_H = 44;
    var HOURS = 24;
    var TIME_GUTTER_W = 52;
    var ALLDAY_ROW_H = 22;

    // ─── palette ───────────────────────────────────────────────────────

    var PALETTE = [
      Color.rgb(63, 81, 181),   // blueberry
      Color.rgb(211, 47, 47),   // tomato
      Color.rgb(230, 145, 56),  // tangerine
      Color.rgb(246, 191, 56),  // banana
      Color.rgb(51, 158, 121),  // basil
      Color.rgb(3, 155, 229),   // peacock
      Color.rgb(142, 36, 170),  // grape
      Color.rgb(97, 97, 97),    // graphite
    ];

    var BG = Color.white;
    var BORDER = Color.rgb(224, 224, 224);
    var BORDER_LIGHT = Color.rgb(238, 238, 238);
    var TEXT_PRIMARY = Color.rgb(32, 33, 36);
    var TEXT_MUTED = Color.rgb(140, 146, 152);
    // Accent palette borrowed from core/lively/commerce/Shop.js's own CSS
    // custom properties (--color-accent/--color-accent-600/--color-accent-100
    // — #e8497e / #d13d70 / #ffeef4), replacing what was originally a blue
    // accent, so this app's chrome matches Shop's pink identity.
    var ACCENT = Color.rgb(232, 73, 126);
    var ACCENT_DARK = Color.rgb(209, 61, 112);
    var ACCENT_LIGHT = Color.rgb(255, 238, 244);
    var HOVER_BG = Color.rgb(245, 245, 248);

    // Memos render in a deliberately neutral/muted style (not the PALETTE
    // colors used for calendars/events) so they read as "to-do" rather
    // than "scheduled" at a glance, alongside event chips in the same cell.
    var MEMO_BG = Color.rgb(243, 244, 246);
    var MEMO_BG_DONE = Color.rgb(236, 236, 238);
    var MEMO_BORDER = Color.rgb(216, 216, 220);
    var MEMO_ACCENT = Color.rgb(120, 120, 128);

    // ─── date helpers (module-scope, plain data in/out — no morphs) ────

    function pad2(n) { return (n < 10 ? "0" : "") + n; }
    function dayKey(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
    function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    function addDays(d, n) { var r = new Date(d.getTime()); r.setDate(r.getDate() + n); return r; }
    function startOfWeek(d) { return addDays(startOfDay(d), -d.getDay()); }
    function isSameDay(a, b) { return dayKey(a) === dayKey(b); }
    function isToday(d) { return isSameDay(d, new Date()); }

    var MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    var DOW_SHORT = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

    function fmtMonthYear(d) { return MONTH_NAMES[d.getMonth()] + " " + d.getFullYear(); }
    function fmtWeekRange(weekStart) {
      var weekEnd = addDays(weekStart, 6);
      if (weekStart.getMonth() === weekEnd.getMonth()) {
        return MONTH_NAMES[weekStart.getMonth()] + " " + weekStart.getFullYear();
      }
      return MONTH_NAMES[weekStart.getMonth()].slice(0, 3) + " – " +
        MONTH_NAMES[weekEnd.getMonth()].slice(0, 3) + " " + weekEnd.getFullYear();
    }
    function fmtDayTitle(d) { return MONTH_NAMES[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear(); }
    function fmtHourLabel(h) {
      if (h === 0) return "12 AM";
      if (h === 12) return "12 PM";
      return (h % 12) + (h < 12 ? " AM" : " PM");
    }
    function fmtTime(d) {
      var h = d.getHours(), m = d.getMinutes();
      var ampm = h < 12 ? "AM" : "PM";
      var h12 = h % 12; if (h12 === 0) h12 = 12;
      return h12 + (m ? ":" + pad2(m) : ":00") + " " + ampm;
    }
    function parseHHMM(s) {
      var m = /^(\d{1,2}):(\d{2})$/.exec((s || "").trim());
      if (!m) return null;
      var h = +m[1], mi = +m[2];
      if (h > 23 || mi > 59) return null;
      return { h: h, m: mi };
    }
    function parseYMD(s) {
      var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec((s || "").trim());
      if (!m) return null;
      return new Date(+m[1], +m[2] - 1, +m[3]);
    }
    function fmtYMD(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }

    // ─── generic morph-building helpers (closures over module consts
    //     only — safe; these run inside subclass prototype methods,
    //     never reconstructed from source) ─────────────────────────────

    function noDrag(m) { m.draggingEnabled = false; m.droppingEnabled = false; m.grabbingEnabled = false; }

    function iconGlyph(rect, glyph, opts) {
      opts = opts || {};
      var t = new lively.morphic.Text(rect);
      t.textString = glyph;
      t.applyStyle({
        fontFamily: "'Material Symbols Rounded'",
        fontSize: (opts.px || 20) * 0.75,
        textColor: opts.color || TEXT_PRIMARY,
        fill: opts.fill || null,
        borderWidth: 0,
        align: "center",
        allowInput: false, selectable: false, clipMode: "hidden",
        whiteSpaceHandling: "pre",
        handStyle: opts.clickable ? "pointer" : null,
      });
      noDrag(t);
      t.eventsAreIgnored = !opts.clickable;
      return t;
    }

    function label(rect, text, opts) {
      opts = opts || {};
      var t = new lively.morphic.Text(rect);
      t.textString = text;
      t.applyStyle({
        fontSize: (opts.px || 12) * 0.75,
        fontWeight: opts.bold ? "bold" : "normal",
        textColor: opts.color || TEXT_PRIMARY,
        fill: opts.fill || null,
        borderWidth: 0,
        align: opts.align || "left",
        allowInput: false, selectable: false,
        clipMode: "hidden",
        whiteSpaceHandling: opts.wrap ? "normal" : "pre",
      });
      noDrag(t);
      t.eventsAreIgnored = true;
      return t;
    }

    function pillButton(rect, text, onClick, opts) {
      opts = opts || {};
      var b = new lively.morphic.Text(rect);
      b.textString = text;
      b.applyStyle({
        fontSize: (opts.px || 12) * 0.75,
        fontWeight: opts.bold ? "600" : "normal",
        textColor: opts.textColor || TEXT_PRIMARY,
        fill: opts.fill != null ? opts.fill : Color.white,
        borderWidth: opts.borderWidth != null ? opts.borderWidth : 1,
        borderColor: opts.borderColor || BORDER,
        borderRadius: opts.radius != null ? opts.radius : rect.height / 2,
        align: "center",
        allowInput: false, selectable: false, clipMode: "hidden",
        whiteSpaceHandling: "pre",
        handStyle: "pointer",
      });
      noDrag(b);
      var baseFill = b.getStyle().fill;
      b.onMouseOver = function () { b.applyStyle({ fill: opts.hoverFill || HOVER_BG }); };
      b.onMouseOut = function () { b.applyStyle({ fill: baseFill }); };
      b.onMouseUp = function (evt) { onClick(evt); evt.stop(); return true; };
      return b;
    }

    function iconButton(rect, glyph, onClick, opts) {
      opts = opts || {};
      // Built at the origin and moved with setPosition: a Text built at
      // rect(x, y) AND then moved is offset twice (its constructor position
      // lands on the shape node, setPosition on the wrapper), which put the
      // dialog's close button ~300px outside it and made the dialog scroll.
      var b = iconGlyph(lively.rect(0, 0, rect.width, rect.height), glyph, { px: opts.px || 20, color: opts.color, clickable: true });
      b.setPosition(lively.pt(rect.x, rect.y));
      b.applyStyle({ fill: null, borderRadius: rect.width / 2, padding: lively.rect(0, Math.round((rect.height - (opts.px || 20)) / 2), 0, 0) });
      b.onMouseOver = function () { b.applyStyle({ fill: HOVER_BG }); };
      b.onMouseOut = function () { b.applyStyle({ fill: null }); };
      b.onMouseUp = function (evt) { onClick(evt); evt.stop(); return true; };
      return b;
    }

    function box(rect, fill, opts) {
      opts = opts || {};
      var m = new lively.morphic.Box(rect);
      m.applyStyle({
        fill: fill,
        borderWidth: opts.borderWidth || 0,
        borderColor: opts.borderColor || null,
        borderRadius: opts.radius || 0,
        clipMode: opts.clip || "visible",
      });
      noDrag(m);
      m.eventsAreIgnored = !opts.clickable;
      return m;
    }

    function textInput(rect, initialValue, opts) {
      opts = opts || {};
      var t = new lively.morphic.Text(rect);
      t.textString = initialValue || "";
      t.applyStyle({
        fontSize: 11 * 0.75, // real 11px — fontSize renders as pt, not px (see CLAUDE.md)
        fill: Color.rgb(248, 249, 250),
        borderWidth: 1, borderColor: BORDER, borderRadius: 4,
        padding: lively.rect(8, 6, 0, 0),
        textColor: TEXT_PRIMARY,
        whiteSpaceHandling: opts.multiline ? "normal" : "pre",
      });
      t.beInputLine && !opts.multiline && t.beInputLine();
      noDrag(t);
      return t;
    }

    // ─── the app itself ─────────────────────────────────────────────────

    var CalendarAppClass = lively.morphic.Box.subclass(
      "lively.calendar.CalendarApp",

      "serialization",
      {
        // friends is a refetchable server-side cache (re-loaded fresh by
        // _bindIdentity's restoreSession callback below), not owned state —
        // taggedFriendHandles (the user's own picks) IS persisted, same as
        // calendars/events. _identityConnection is a live lively.bindings
        // Connection to the global lively.identity.did singleton — Shop.js's
        // own doNotSerialize comment explains why that can't survive
        // serialization (produces broken stub registry entries).
        doNotSerialize: ["_refs", "_popover", "_scrim", "_dialog", "_chooser", "_searchDropdown", "_searchScrim", "_dlgEditingMemoId", "friends", "_identityConnection"],
      },

      "initialization",
      {
        DEFAULT_EXTENT: { w: APP_W, h: APP_H },

        initialize: function ($super, optExtent) {
          $super(optExtent || lively.rect(0, 0, APP_W, APP_H));
          this.setFill(BG);
          this.setBorderWidth(0);
          this.setClipMode("hidden");
          this.setMinExtent(lively.pt(MIN_W, MIN_H));
        },

        // $super() above synchronously triggers prepareForNewRenderContext
        // (=> this very method) as part of Box's own construction, so the
        // very first call happens before any of initialize's own body below
        // the $super() line would otherwise have run — _setup() has to seed
        // the data model itself, guarded so a later call (deserialize
        // restoring calendars/events before this ever runs) never clobbers it.
        _setup: function () {
          if (!this.calendars) {
            this.calendars = [
              { id: "manual", name: "My Events", color: PALETTE[0], visible: true, source: "manual" },
            ];
            this.events = [];
            this.memos = [];
            this.currentDate = startOfDay(new Date());
            this.currentView = "month";
            this.nextId = 1;
            this.taggedFriendHandles = [];
          }
          this.friends = this.friends || []; // excluded from serialization — always refetched below

          this._refs = {};
          this.removeAllMorphs();
          this._buildHeader();
          this._buildSidebar();
          this._buildMainArea();
          this._chromeBuilt = true;
          this._relayout();
          this._unbindIdentity();
          this._bindIdentity();
        },

        prepareForNewRenderContext: function ($super, renderCtx) {
          $super(renderCtx);
          this._setup();
        },

        setExtent: function ($super, ext) {
          var r = $super(ext);
          if (this._chromeBuilt) this._relayout();
          return r;
        },

        remove: function ($super) {
          this._unbindIdentity();
          $super();
        },
      },

      "friends",
      {
        _bindIdentity: function () {
          if (typeof lively === "undefined" || !lively.bindings || !lively.identity || !lively.identity.did) return;
          var self = this;
          this._identityConnection = lively.bindings.connect(lively.identity.did, "identityChanged", self, "_onIdentityChanged");
          // restoreSession() is idempotent — guards against DID.js's own
          // boot-time restoreSession() resolving before this morph even
          // existed and the connect() above missing that signal (same race
          // Shop.js/ConstellationLounge.js hit — see project-restore-session-race).
          if (lively.identity.did.restoreSession) {
            lively.identity.did.restoreSession(function () { self._onIdentityChanged(); });
          }
        },

        _unbindIdentity: function () {
          if (this._identityConnection && this._identityConnection.disconnect) this._identityConnection.disconnect();
          this._identityConnection = null;
        },

        _onIdentityChanged: function () {
          this._loadFriends();
          this._loadRsvpEvents();
        },

        _loadFriends: function () {
          var self = this;
          var signedIn = typeof lively !== "undefined" && lively.identity && lively.identity.did &&
            lively.identity.did.isLoggedIn && lively.identity.did.isLoggedIn();
          if (!signedIn) {
            this.friends = [];
            if (this._chromeBuilt) this._renderFriendsList();
            return;
          }
          var handle = lively.identity.did.currentUser().handle;
          fetch("/@" + handle + "/friends", { credentials: "include" })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              self.friends = (data && data.friends) || [];
              if (self._chromeBuilt) self._renderFriendsList();
            })
            .catch(function (err) {
              console.warn("[Calendar] Failed to load friends:", err.message);
              self.friends = [];
              if (self._chromeBuilt) self._renderFriendsList();
            });
        },

        // Every constellation event the signed-in user has RSVP'd
        // going/maybe to, across any constellation they're a member of —
        // read-only, derived entirely from event_rsvps server-side
        // (ConstellationRegistry.js's getRsvpEventsForUser), never written
        // back from here. Mirrors _loadFriends's identity-sync idiom
        // exactly: called from _onIdentityChanged (so it runs both on
        // boot, via _bindIdentity's restoreSession callback, and on any
        // later sign-in/out), guarded the same way before re-rendering.
        _loadRsvpEvents: function () {
          var self = this;
          var signedIn = typeof lively !== "undefined" && lively.identity && lively.identity.did &&
            lively.identity.did.isLoggedIn && lively.identity.did.isLoggedIn();
          if (!signedIn) {
            this.events = this.events.filter(function (e) { return e.calendarId !== "constellation-rsvps"; });
            if (this._chromeBuilt) this._relayout();
            return;
          }
          var handle = lively.identity.did.currentUser().handle;
          var base = lively.identity.did.baseUrl();
          fetch(base + "/@" + handle + "/calendar/rsvp-events", { credentials: "include" })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              var rsvpEvents = (data && data.events) || [];
              if (!self._calendarById("constellation-rsvps")) {
                self.calendars.push({
                  id: "constellation-rsvps", name: "Constellation Events",
                  color: PALETTE[self.calendars.length % PALETTE.length],
                  visible: true, source: "constellation-rsvp",
                });
              }
              // Replace, don't append — a re-fetch (e.g. after switching a
              // response to "not going") must make a stale entry
              // disappear, not just stop the list from growing.
              self.events = self.events.filter(function (e) { return e.calendarId !== "constellation-rsvps"; });
              rsvpEvents.forEach(function (ev) {
                var start = new Date(ev.startsAt);
                if (isNaN(start.getTime())) return;
                var id = "rsvp-" + ev.id;
                self.events.push({
                  id: id, calendarId: "constellation-rsvps", uid: id,
                  title: ev.title, start: start,
                  end: new Date(start.getTime() + 3600000), // 1hr default — constellation events have no stored end time
                  allDay: false, location: ev.location || "", description: "", attendees: [],
                });
              });
              if (self._chromeBuilt) self._relayout();
            })
            .catch(function (err) {
              console.warn("[Calendar] Failed to load RSVP'd events:", err.message);
            });
        },

        _friendAvatar: function (rect, friend) {
          var img = new lively.morphic.Image(rect);
          img.setImageURL(friend.avatarUrl ||
            lively.identity.postCardUtils.identiconDataUrl(friend.handle || friend.did, rect.width));
          img.applyStyle({ borderRadius: rect.width / 2, borderWidth: 0, clipMode: "hidden" });
          noDrag(img);
          img.eventsAreIgnored = true;
          return img;
        },

        _makeFriendRow: function (rect, friend, onClick, opts) {
          opts = opts || {};
          var row = box(rect, null, { clickable: true });
          row.addMorph(this._friendAvatar(lively.rect(0, (rect.height - 20) / 2, 20, 20), friend));
          row.addMorph(label(lively.rect(26, 0, rect.width - (opts.tagged != null ? 48 : 26), rect.height), "@" + friend.handle, { px: 10.5 }));
          if (opts.tagged != null) {
            var tag = box(lively.rect(rect.width - 20, (rect.height - 16) / 2, 16, 16), opts.tagged ? ACCENT : Color.white,
              { borderWidth: 1.5, borderColor: opts.tagged ? ACCENT : BORDER, radius: 3 });
            tag.eventsAreIgnored = true;
            if (opts.tagged) tag.addMorph(iconGlyph(lively.rect(0, -1, 16, 16), "check", { px: 12, color: Color.white }));
            row.addMorph(tag);
          }
          row.onMouseOver = function () { row.applyStyle({ fill: HOVER_BG }); };
          row.onMouseOut = function () { row.applyStyle({ fill: null }); };
          row.onMouseUp = function (evt) { onClick(friend); evt.stop(); return true; };
          return row;
        },
      },

      "data model",
      {
        _calendarById: function (id) {
          for (var i = 0; i < this.calendars.length; i++) if (this.calendars[i].id === id) return this.calendars[i];
          return null;
        },

        visibleEvents: function () {
          var self = this;
          var hidden = {};
          this.calendars.forEach(function (c) { if (!c.visible) hidden[c.id] = true; });
          return this.events.filter(function (e) { return !hidden[e.calendarId]; });
        },

        eventsOverlapping: function (rangeStart, rangeEnd) {
          return this.visibleEvents().filter(function (e) {
            return e.start < rangeEnd && e.end > rangeStart;
          }).sort(function (a, b) {
            if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
            return a.start - b.start;
          });
        },

        colorForEvent: function (e) {
          var cal = this._calendarById(e.calendarId);
          return (cal && cal.color) || PALETTE[0];
        },

        addManualEvent: function (data) {
          var id = "evt-" + (this.nextId++);
          this.events.push({
            id: id, calendarId: data.calendarId || "manual", uid: id,
            title: data.title, start: data.start, end: data.end,
            allDay: !!data.allDay, location: data.location || "", description: data.description || "",
            attendees: data.attendees || [],
          });
          return id;
        },

        deleteEvent: function (id) {
          this.events = this.events.filter(function (e) { return e.id !== id; });
        },

        addCalendarFromImport: function (name, parsedEvents, colorIdx) {
          var id = "import-" + (this.nextId++);
          var cal = { id: id, name: name, color: PALETTE[colorIdx % PALETTE.length], visible: true, source: "import" };
          this.calendars.push(cal);
          var self = this;
          parsedEvents.forEach(function (e) {
            self.events.push({
              id: id + "::" + e.uid, calendarId: id, uid: e.uid,
              title: e.title, start: e.start, end: e.end,
              allDay: e.allDay, location: e.location, description: e.description,
              attendees: [],
            });
          });
          return cal;
        },

        toggleCalendarVisibility: function (id) {
          var cal = this._calendarById(id);
          if (cal) cal.visible = !cal.visible;
        },

        memosOnDay: function (d) {
          return this.memos.filter(function (m) { return isSameDay(m.date, d); });
        },

        addManualMemo: function (data) {
          var id = "memo-" + (this.nextId++);
          this.memos.push({
            id: id, date: startOfDay(data.date),
            bodyMarkup: data.bodyMarkup || [], bodyText: data.bodyText || "",
            tags: data.tags || [], done: false,
          });
          return id;
        },

        updateMemo: function (id, patch) {
          var m = this._memoById(id);
          if (m) Object.extend(m, patch);
        },

        _memoById: function (id) {
          for (var i = 0; i < this.memos.length; i++) if (this.memos[i].id === id) return this.memos[i];
          return null;
        },

        deleteMemo: function (id) {
          this.memos = this.memos.filter(function (m) { return m.id !== id; });
        },

        toggleMemoDone: function (id) {
          var m = this._memoById(id);
          if (m) m.done = !m.done;
        },

        // Unified events+memos search, used by the header search field.
        // Plain lowercase-substring match — the dataset here is small
        // (a single user's own calendar, held entirely in memory), so
        // there's no need for anything fancier.
        searchAll: function (query) {
          query = (query || "").trim().toLowerCase();
          if (!query) return [];
          var results = [];
          this.visibleEvents().forEach(function (e) {
            var hay = [e.title, e.location, e.description].join(" ").toLowerCase();
            if (hay.indexOf(query) !== -1) results.push({ type: "event", date: e.start, item: e });
          });
          this.memos.forEach(function (m) {
            var hay = [m.bodyText, (m.tags || []).join(" ")].join(" ").toLowerCase();
            if (hay.indexOf(query) !== -1) results.push({ type: "memo", date: m.date, item: m });
          });
          results.sort(function (a, b) { return a.date - b.date; });
          return results.slice(0, 8);
        },
      },

      "navigation",
      {
        setView: function (view) {
          this.currentView = view;
          this._renderMain();
          this._renderSidebar();
        },

        goToday: function () {
          this.currentDate = startOfDay(new Date());
          this._renderMain();
          this._renderSidebar();
        },

        goPrev: function () { this._step(-1); },
        goNext: function () { this._step(1); },

        _step: function (dir) {
          var d = this.currentDate;
          if (this.currentView === "month") this.currentDate = new Date(d.getFullYear(), d.getMonth() + dir, 1);
          else if (this.currentView === "week") this.currentDate = addDays(d, 7 * dir);
          else this.currentDate = addDays(d, dir);
          this._renderMain();
          this._renderSidebar();
        },

        goToDate: function (d) {
          this.currentDate = startOfDay(d);
          this._renderMain();
          this._renderSidebar();
        },
      },

      "chrome: layout",
      {
        _relayout: function () {
          var ext = this.getExtent();
          var w = Math.max(ext.x, MIN_W), h = Math.max(ext.y, MIN_H);
          this._w = w; this._h = h;

          this._refs.header.setExtent(lively.pt(w, HEADER_H));
          this._refs.sidebar.setExtent(lively.pt(SIDEBAR_W, h - HEADER_H));
          this._refs.sidebar.setPosition(lively.pt(0, HEADER_H));
          this._refs.mainArea.setPosition(lively.pt(SIDEBAR_W, HEADER_H));
          this._refs.mainArea.setExtent(lively.pt(w - SIDEBAR_W, h - HEADER_H));
          var switcherX = w - 232;
          this._refs.viewSwitcher.setPosition(lively.pt(switcherX, 14));
          // Search field sits between the fixed title box and the switcher,
          // which itself moves with window width — clamp its width so it
          // never overlaps the switcher on a narrower window.
          this._refs.searchField.setExtent(lively.pt(Math.max(40, Math.min(300, switcherX - 16 - 628)), 30));
          this._hideSearchResults();

          this._renderMain();
          this._renderSidebar();
        },
      },

      "chrome: header",
      {
        _buildHeader: function () {
          var self = this;
          var header = box(lively.rect(0, 0, APP_W, HEADER_H), BG, { borderWidth: 0 });
          header.applyStyle({ borderColor: BORDER });
          this._refs.header = header;
          this.addMorph(header);

          var bottomLine = box(lively.rect(0, HEADER_H - 1, APP_W, 1), BORDER);
          header.addMorph(bottomLine);
          this._refs.headerBottomLine = bottomLine;

          header.addMorph(iconGlyph(lively.rect(16, 16, 28, 28), "calendar_month", { px: 26, color: ACCENT }));
          header.addMorph(label(lively.rect(48, 18, 90, 24), "Calendar", { px: 15, bold: true }));

          header.addMorph(pillButton(lively.rect(140, 15, 68, 30), "Today", function () { self.goToday(); }, { fill: Color.white }));
          header.addMorph(iconButton(lively.rect(216, 14, 32, 32), "chevron_left", function () { self.goPrev(); }, { px: 20 }));
          header.addMorph(iconButton(lively.rect(250, 14, 32, 32), "chevron_right", function () { self.goNext(); }, { px: 20 }));

          var title = label(lively.rect(292, 18, 300, 24), "", { px: 16, bold: true });
          header.addMorph(title);
          this._refs.headerTitle = title;

          // ─── search (events + memos) — sits in the free gap between the
          // title label's own fixed-width box (ends x=592, regardless of
          // actual title text length) and the view switcher (starts
          // x=APP_W-232=948) ───
          header.addMorph(iconGlyph(lively.rect(606, 19, 20, 22), "search", { px: 16, color: TEXT_MUTED }));
          var searchField = textInput(lively.rect(628, 15, 300, 30), "");
          searchField.applyStyle({ borderRadius: 15, padding: lively.rect(10, 7, 0, 0) });
          header.addMorph(searchField);
          this._refs.searchField = searchField;
          var origSearchOnKeyUp = searchField.onKeyUp.bind(searchField);
          searchField.onKeyUp = function (evt) {
            var result = origSearchOnKeyUp(evt);
            self._renderSearchResults();
            return result;
          };

          var switcher = box(lively.rect(APP_W - 232, 14, 216, 32), Color.rgb(248, 249, 250), { radius: 16, borderWidth: 1, borderColor: BORDER, clip: "hidden" });
          header.addMorph(switcher);
          this._refs.viewSwitcher = switcher;
          var views = [["month", "Month"], ["week", "Week"], ["day", "Day"]];
          this._refs.viewButtons = {};
          views.forEach(function (v, i) {
            var btn = pillButton(lively.rect(i * 72, 0, 72, 32), v[1], function () { self.setView(v[0]); }, { radius: 16, borderWidth: 0, fill: null, px: 11.5 });
            switcher.addMorph(btn);
            self._refs.viewButtons[v[0]] = btn;
          });
        },

        _updateHeaderChrome: function () {
          var w = this._w;
          this._refs.header.setExtent(lively.pt(w, HEADER_H));
          this._refs.headerBottomLine.setExtent(lively.pt(w, 1));
          var titleText = this.currentView === "month" ? fmtMonthYear(this.currentDate)
            : this.currentView === "week" ? fmtWeekRange(startOfWeek(this.currentDate))
              : fmtDayTitle(this.currentDate);
          this._refs.headerTitle.textString = titleText;

          var self = this;
          Object.keys(this._refs.viewButtons).forEach(function (v) {
            var active = self.currentView === v;
            self._refs.viewButtons[v].applyStyle({
              fill: active ? Color.white : null,
              textColor: active ? ACCENT : TEXT_PRIMARY,
              fontWeight: active ? "600" : "normal",
            });
          });
        },
      },

      "search",
      {
        _renderSearchResults: function () {
          var self = this;
          var query = (this._refs.searchField.textString || "").trim();
          if (!query) { this._hideSearchResults(); return; }
          var results = this.searchAll(query);
          this._hideSearchResults();
          if (!results.length) return;

          var searchScrim = box(lively.rect(0, 0, this._w, this._h), Color.rgba(0, 0, 0, 0), { clickable: true });
          searchScrim.onMouseUp = function (evt) { self._hideSearchResults(); evt.stop(); return true; };
          this.addMorph(searchScrim);
          this._searchScrim = searchScrim;

          var fieldExtent = this._refs.searchField.getExtent();
          var fieldPos = this.localize(this._refs.searchField.worldPoint(lively.pt(0, fieldExtent.y)));
          var dw = Math.max(260, fieldExtent.x + 20);
          var rowH = 34;
          var dh = results.length * rowH + 8;
          var dx = Math.min(Math.max(0, fieldPos.x - 10), this._w - dw - 8);
          var dy = fieldPos.y + 6;

          var dropdown = box(lively.rect(dx, dy, dw, dh), Color.white, { radius: 8, borderWidth: 1, borderColor: BORDER, clip: "auto", clickable: true });
          this.addMorph(dropdown);
          this._searchDropdown = dropdown;

          results.forEach(function (r, i) {
            var row = box(lively.rect(4, 4 + i * rowH, dw - 8, rowH - 2), null, { clickable: true, radius: 4 });
            var isMemo = r.type === "memo";
            row.addMorph(iconGlyph(lively.rect(6, (rowH - 2 - 16) / 2, 16, 16), isMemo ? "event_note" : "event", { px: 14, color: isMemo ? MEMO_ACCENT : self.colorForEvent(r.item) }));
            var titleText = isMemo ? (r.item.bodyText || "(empty memo)") : r.item.title;
            row.addMorph(label(lively.rect(28, 3, dw - 100, 15), titleText, { px: 10.5 }));
            row.addMorph(label(lively.rect(28, 17, dw - 100, 13), fmtDayTitle(r.date), { px: 8.5, color: TEXT_MUTED }));
            row.onMouseOver = function () { row.applyStyle({ fill: HOVER_BG }); };
            row.onMouseOut = function () { row.applyStyle({ fill: null }); };
            row.onMouseUp = function (evt) {
              // Popover positioning reads anchorMorph.worldPoint(...), so it
              // has to run BEFORE the dropdown (and this row) is torn down —
              // hideSearchResults happens last, purely for cleanup.
              self.goToDate(r.date);
              if (isMemo) self._showMemoPopover(r.item, row);
              else self._showEventPopover(r.item, row);
              self._hideSearchResults();
              evt.stop(); return true;
            };
            dropdown.addMorph(row);
          });
        },

        _hideSearchResults: function () {
          if (this._searchDropdown) { this._searchDropdown.remove(); this._searchDropdown = null; }
          if (this._searchScrim) { this._searchScrim.remove(); this._searchScrim = null; }
        },
      },

      "chrome: sidebar",
      {
        _buildSidebar: function () {
          var self = this;
          var sidebar = box(lively.rect(0, HEADER_H, SIDEBAR_W, APP_H - HEADER_H), BG);
          this.addMorph(sidebar);
          this._refs.sidebar = sidebar;

          var rightLine = box(lively.rect(SIDEBAR_W - 1, 0, 1, APP_H - HEADER_H), BORDER);
          sidebar.addMorph(rightLine);
          this._refs.sidebarRightLine = rightLine;

          sidebar.addMorph(pillButton(lively.rect(16, 16, SIDEBAR_W - 32, 36), "+  Create", function () { self._openCreateChooser(self.currentDate); },
            { fill: ACCENT, textColor: Color.white, radius: 18, borderWidth: 0, px: 13, bold: true, hoverFill: ACCENT_DARK }));

          sidebar.addMorph(pillButton(lively.rect(16, 60, SIDEBAR_W - 32, 30), "Import .ics / .vcs / .csv", function () { self._promptImportFile(); },
            { fill: Color.white, radius: 6, px: 10.5 }));

          var mini = box(lively.rect(12, 104, SIDEBAR_W - 24, 176), BG);
          sidebar.addMorph(mini);
          this._refs.miniCalendar = mini;

          // ─── My Friends (search + tag; tagged friends default onto new events) ───
          var friendsTitle = label(lively.rect(16, 292, SIDEBAR_W - 32, 18), "My Friends", { px: 12, bold: true, color: TEXT_MUTED });
          sidebar.addMorph(friendsTitle);

          var friendsSearch = textInput(lively.rect(12, 312, SIDEBAR_W - 24, 26), "");
          friendsSearch.applyStyle({ fontSize: 10 * 0.75 });
          sidebar.addMorph(friendsSearch);
          this._refs.friendsSearch = friendsSearch;
          var origFriendsOnKeyUp = friendsSearch.onKeyUp.bind(friendsSearch);
          friendsSearch.onKeyUp = function (evt) {
            var result = origFriendsOnKeyUp(evt);
            self._renderFriendsList();
            return result;
          };

          var friendsList = box(lively.rect(12, 342, SIDEBAR_W - 24, 128), BG, { clip: "auto" });
          sidebar.addMorph(friendsList);
          this._refs.friendsList = friendsList;

          // ─── My calendars ───
          var listTitle = label(lively.rect(16, 482, SIDEBAR_W - 32, 20), "My calendars", { px: 12, bold: true, color: TEXT_MUTED });
          sidebar.addMorph(listTitle);

          var list = box(lively.rect(12, 506, SIDEBAR_W - 24, APP_H - HEADER_H - 520), BG, { clip: "auto" });
          sidebar.addMorph(list);
          this._refs.calendarList = list;
        },

        _renderSidebar: function () {
          this._renderMiniCalendar();
          this._renderFriendsList();
          this._renderCalendarList();
          this._updateHeaderChrome();
        },

        _renderFriendsList: function () {
          var self = this;
          var listBox = this._refs.friendsList;
          if (!listBox) return; // chrome not built yet — _loadFriends() may resolve before _setup() finishes
          listBox.removeAllMorphs();

          var signedIn = typeof lively !== "undefined" && lively.identity && lively.identity.did &&
            lively.identity.did.isLoggedIn && lively.identity.did.isLoggedIn();
          if (!signedIn) {
            listBox.addMorph(label(lively.rect(2, 4, listBox.getExtent().x - 4, 32), "Sign in to see your friends.", { px: 10, color: TEXT_MUTED, wrap: true }));
            return;
          }

          var query = (this._refs.friendsSearch.textString || "").trim().toLowerCase();
          var matches = this.friends.filter(function (f) { return !query || (f.handle || "").toLowerCase().indexOf(query) !== -1; });

          if (!matches.length) {
            listBox.addMorph(label(lively.rect(2, 4, listBox.getExtent().x - 4, 32),
              this.friends.length ? "No matches." : "No friends yet.", { px: 10, color: TEXT_MUTED }));
            return;
          }

          var rowH = 24;
          matches.forEach(function (f, i) {
            var tagged = self.taggedFriendHandles.indexOf(f.handle) !== -1;
            var row = self._makeFriendRow(lively.rect(0, i * rowH, listBox.getExtent().x, rowH), f, function (friend) {
              var idx = self.taggedFriendHandles.indexOf(friend.handle);
              if (idx === -1) self.taggedFriendHandles.push(friend.handle);
              else self.taggedFriendHandles.splice(idx, 1);
              self._renderFriendsList();
            }, { tagged: tagged });
            listBox.addMorph(row);
          });
        },

        _renderMiniCalendar: function () {
          var self = this;
          var mini = this._refs.miniCalendar;
          mini.removeAllMorphs();
          var focus = this.currentDate;
          var cellW = mini.getExtent().x / 7;
          var headerH = 20, cellH = 22;

          mini.addMorph(iconButton(lively.rect(0, 0, 18, 18), "chevron_left", function () {
            self.currentDate = new Date(focus.getFullYear(), focus.getMonth() - 1, 1);
            self._renderMain(); self._renderSidebar();
          }, { px: 14 }));
          mini.addMorph(label(lively.rect(18, 0, cellW * 7 - 36, headerH), MONTH_NAMES[focus.getMonth()].slice(0, 3) + " " + focus.getFullYear(), { px: 10.5, bold: true, align: "center" }));
          mini.addMorph(iconButton(lively.rect(cellW * 7 - 18, 0, 18, 18), "chevron_right", function () {
            self.currentDate = new Date(focus.getFullYear(), focus.getMonth() + 1, 1);
            self._renderMain(); self._renderSidebar();
          }, { px: 14 }));

          DOW_SHORT.forEach(function (d, i) {
            mini.addMorph(label(lively.rect(i * cellW, headerH, cellW, 14), d[0], { px: 8.5, align: "center", color: TEXT_MUTED }));
          });

          var monthStart = new Date(focus.getFullYear(), focus.getMonth(), 1);
          var gridStart = startOfWeek(monthStart);
          var monthEnd = new Date(focus.getFullYear(), focus.getMonth() + 1, 0);
          var gridEnd = addDays(startOfWeek(monthEnd), 6);
          var numDays = Math.round((gridEnd - gridStart) / 86400000) + 1;

          for (var i = 0; i < numDays; i++) {
            var d = addDays(gridStart, i);
            var col = i % 7, row = Math.floor(i / 7);
            var inMonth = d.getMonth() === focus.getMonth();
            var cell = box(lively.rect(col * cellW, headerH + 14 + row * cellH, cellW, cellH), null, { clickable: true });
            cell.eventsAreIgnored = false;
            var isSel = isSameDay(d, focus);
            var isTod = isToday(d);
            var dayLbl = label(lively.rect(0, 2, cellW, cellH - 4), String(d.getDate()), {
              px: 10, align: "center",
              color: isSel ? Color.white : (isTod ? ACCENT : (inMonth ? TEXT_PRIMARY : TEXT_MUTED)),
              bold: isTod || isSel,
            });
            cell.addMorph(dayLbl);
            if (isSel) cell.applyStyle({ fill: ACCENT, radius: cellH / 2 });
            cell.onMouseUp = (function (day) {
              return function (evt) { self.goToDate(day); self._openCreateChooser(day); evt.stop(); return true; };
            })(d);
            mini.addMorph(cell);
          }
        },

        _renderCalendarList: function () {
          var self = this;
          var list = this._refs.calendarList;
          list.removeAllMorphs();
          var y = 0, rowH = 26;
          this.calendars.forEach(function (cal) {
            var row = box(lively.rect(0, y, list.getExtent().x, rowH), null, { clickable: true });
            var swatch = box(lively.rect(2, 6, 14, 14), cal.visible ? cal.color : Color.white, { borderWidth: 1.5, borderColor: cal.color, radius: 3, clickable: true });
            if (cal.visible) swatch.addMorph(iconGlyph(lively.rect(0, -1, 14, 14), "check", { px: 11, color: Color.white }));
            row.addMorph(swatch);
            row.addMorph(label(lively.rect(22, 4, list.getExtent().x - 26, 18), cal.name, { px: 11 }));
            row.onMouseUp = (function (id) {
              return function (evt) { self.toggleCalendarVisibility(id); self._renderCalendarList(); self._renderMain(); evt.stop(); return true; };
            })(cal.id);
            list.addMorph(row);
            y += rowH;
          });
        },
      },

      "chrome: main area",
      {
        _buildMainArea: function () {
          var main = box(lively.rect(SIDEBAR_W, HEADER_H, APP_W - SIDEBAR_W, APP_H - HEADER_H), BG, { clip: "hidden" });
          this.addMorph(main);
          this._refs.mainArea = main;
        },

        _renderMain: function () {
          var main = this._refs.mainArea;
          main.removeAllMorphs();
          this._updateHeaderChrome();
          if (this.currentView === "month") this._renderMonthView(main);
          else if (this.currentView === "week") this._renderWeekAndDayShared(main, startOfWeek(this.currentDate), 7);
          else this._renderWeekAndDayShared(main, startOfDay(this.currentDate), 1);
        },
      },

      "month view",
      {
        _renderMonthView: function (main) {
          var self = this;
          var w = main.getExtent().x, h = main.getExtent().y;
          var focus = this.currentDate;
          var monthStart = new Date(focus.getFullYear(), focus.getMonth(), 1);
          var gridStart = startOfWeek(monthStart);
          var monthEnd = new Date(focus.getFullYear(), focus.getMonth() + 1, 0);
          var gridEnd = addDays(startOfWeek(monthEnd), 6);
          var numDays = Math.round((gridEnd - gridStart) / 86400000) + 1;
          var rows = numDays / 7;

          var dowH = 26;
          var colW = w / 7;
          var rowH = (h - dowH) / rows;

          DOW_SHORT.forEach(function (d, i) {
            main.addMorph(label(lively.rect(i * colW, 0, colW, dowH), d, { px: 10.5, align: "center", color: TEXT_MUTED, bold: true }));
          });
          main.addMorph(box(lively.rect(0, dowH - 1, w, 1), BORDER));

          for (var i = 0; i < numDays; i++) {
            var d = addDays(gridStart, i);
            var col = i % 7, row = Math.floor(i / 7);
            var cellRect = lively.rect(col * colW, dowH + row * rowH, colW, rowH);
            var inMonth = d.getMonth() === focus.getMonth();
            var cell = box(cellRect, inMonth ? Color.white : Color.rgb(250, 250, 251), { borderWidth: 0.5, borderColor: BORDER_LIGHT, clip: "hidden", clickable: true });
            // Morph mouseup dispatch here is capture-first (outer ancestor
            // before nested children), so cell's own handler would always
            // win over an event chip nested inside it — chip.onMouseUp would
            // never get a chance to run once cell calls evt.stop() first.
            // Cell hit-tests its own chip/"+N more" children itself instead,
            // falling back to "empty day cell -> open create chooser".
            cell.onMouseUp = (function (day, cellRef) {
              return function (evt) {
                var localPt = cellRef.localize(evt.getPosition());
                var hitChip = cellRef.submorphs.find(function (m) { return m._calEvent && m.bounds().containsPoint(localPt); });
                var hitMemoChip = !hitChip && cellRef.submorphs.find(function (m) { return m._calMemo && m.bounds().containsPoint(localPt); });
                if (hitChip) {
                  self._showEventPopover(hitChip._calEvent, hitChip);
                } else if (hitMemoChip) {
                  self._showMemoPopover(hitMemoChip._calMemo, hitMemoChip);
                } else {
                  var hitMore = cellRef.submorphs.find(function (m) { return m._calMoreDay && m.bounds().containsPoint(localPt); });
                  if (hitMore) { self.goToDate(hitMore._calMoreDay); self.setView("day"); }
                  else { self._openCreateChooser(day); }
                }
                evt.stop();
                return true;
              };
            })(d, cell);

            var dateLabel = isToday(d)
              ? box(lively.rect(colW - 28, 4, 22, 22), ACCENT, { radius: 11 })
              : null;
            if (dateLabel) {
              dateLabel.eventsAreIgnored = true;
              dateLabel.addMorph(label(lively.rect(0, 2, 22, 18), String(d.getDate()), { px: 10.5, align: "center", color: Color.white, bold: true }));
              cell.addMorph(dateLabel);
            } else {
              cell.addMorph(label(lively.rect(colW - 30, 4, 26, 18), String(d.getDate()), { px: 10.5, align: "right", color: inMonth ? TEXT_PRIMARY : TEXT_MUTED }));
            }

            var dayEvents = this.eventsOverlapping(d, addDays(d, 1));
            var dayMemos = this.memosOnDay(d);
            var dayItems = dayEvents.map(function (e) { return { type: "event", data: e }; })
              .concat(dayMemos.map(function (m) { return { type: "memo", data: m }; }));
            var chipH = 16, chipY = 26;
            var maxChips = Math.max(1, Math.floor((rowH - chipY - 4) / chipH));
            var shown = dayItems.slice(0, maxChips - (dayItems.length > maxChips ? 1 : 0));
            shown.forEach(function (it, idx) {
              var rect = lively.rect(2, chipY + idx * chipH, colW - 4, chipH - 2);
              if (it.type === "event") {
                var chip = self._makeEventChip(rect, it.data, "month");
                chip._calEvent = it.data; // read by cell.onMouseUp's manual hit-test above
                cell.addMorph(chip);
              } else {
                var mchip = self._makeMemoChip(rect, it.data, "month");
                mchip._calMemo = it.data; // read by cell.onMouseUp's manual hit-test above
                cell.addMorph(mchip);
              }
            });
            if (dayItems.length > shown.length) {
              var more = label(lively.rect(2, chipY + shown.length * chipH, colW - 4, chipH), "+" + (dayItems.length - shown.length) + " more", { px: 9.5, color: TEXT_MUTED });
              more.eventsAreIgnored = false;
              more.applyStyle({ handStyle: "pointer" });
              more._calMoreDay = d; // read by cell.onMouseUp's manual hit-test above
              cell.addMorph(more);
            }

            main.addMorph(cell);
          }
        },
      },

      "week/day view (shared hour grid)",
      {
        _renderWeekAndDayShared: function (main, rangeStart, numCols) {
          var self = this;
          var w = main.getExtent().x, h = main.getExtent().y;
          var colW = (w - TIME_GUTTER_W) / numCols;
          var days = [];
          for (var i = 0; i < numCols; i++) days.push(addDays(rangeStart, i));

          var headerH = 40;
          days.forEach(function (d, i) {
            var x = TIME_GUTTER_W + i * colW;
            main.addMorph(label(lively.rect(x, 4, colW, 16), DOW_SHORT[d.getDay()], { px: 9.5, align: "center", color: TEXT_MUTED, bold: true }));
            var numColor = isToday(d) ? Color.white : TEXT_PRIMARY;
            var numBg = isToday(d) ? box(lively.rect(x + colW / 2 - 12, 18, 24, 20), ACCENT, { radius: 10 }) : null;
            if (numBg) { numBg.eventsAreIgnored = true; main.addMorph(numBg); }
            main.addMorph(label(lively.rect(x, 20, colW, 16), String(d.getDate()), { px: 10.5, align: "center", color: numColor, bold: isToday(d) }));
          });
          main.addMorph(box(lively.rect(0, headerH - 1, w, 1), BORDER));

          // all-day row — memos have no time component, so they render here
          // alongside all-day events rather than in the timed hour grid.
          var alldayItems = days.map(function (d) {
            var evs = self.eventsOverlapping(d, addDays(d, 1)).filter(function (e) { return e.allDay; })
              .map(function (e) { return { type: "event", data: e }; });
            var memos = self.memosOnDay(d).map(function (m) { return { type: "memo", data: m }; });
            return evs.concat(memos);
          });
          var maxAllDay = Math.max(0, alldayItems.reduce(function (m, arr) { return Math.max(m, arr.length); }, 0));
          var alldayH = maxAllDay ? maxAllDay * ALLDAY_ROW_H + 4 : 0;
          if (alldayH) {
            alldayItems.forEach(function (items, i) {
              var x = TIME_GUTTER_W + i * colW;
              items.forEach(function (it, row) {
                var rect = lively.rect(x + 1, headerH + 2 + row * ALLDAY_ROW_H, colW - 2, ALLDAY_ROW_H - 2);
                var chip = it.type === "event" ? self._makeEventChip(rect, it.data, "block") : self._makeMemoChip(rect, it.data, "block");
                main.addMorph(chip);
              });
            });
            main.addMorph(box(lively.rect(0, headerH + alldayH - 1, w, 1), BORDER));
          }

          var gridY = headerH + alldayH;
          var gridH = h - gridY;
          var scrollBox = box(lively.rect(0, gridY, w, gridH), BG, { clip: "auto" });
          main.addMorph(scrollBox);
          var contentH = HOURS * HOUR_ROW_H;
          scrollBox.setExtent(lively.pt(w, gridH));

          for (var hr = 0; hr < HOURS; hr++) {
            scrollBox.addMorph(label(lively.rect(0, hr * HOUR_ROW_H - 6, TIME_GUTTER_W - 8, 14), fmtHourLabel(hr), { px: 9, align: "right", color: TEXT_MUTED }));
            scrollBox.addMorph(box(lively.rect(TIME_GUTTER_W, hr * HOUR_ROW_H, w - TIME_GUTTER_W, 1), BORDER_LIGHT));
          }
          for (var c = 1; c < numCols; c++) {
            scrollBox.addMorph(box(lively.rect(TIME_GUTTER_W + c * colW, 0, 1, contentH), BORDER_LIGHT));
          }
          if (contentH < gridH) scrollBox.setExtent(lively.pt(w, gridH)); else scrollBox.setExtent(lively.pt(w, contentH));

          // Day-column click-catchers ("click empty slot to add an event")
          // are added FIRST, so the event blocks added below land on top of
          // them in sibling z-order and win hit-testing over the catcher.
          days.forEach(function (d, i) {
            var x = TIME_GUTTER_W + i * colW;
            var dayCol = box(lively.rect(x, 0, colW, contentH), Color.rgba(0, 0, 0, 0), { clickable: true });
            dayCol.onMouseUp = (function (day) {
              return function (evt) { self._hidePopover(); self._openCreateChooser(day); evt.stop(); return true; };
            })(d);
            scrollBox.addMorph(dayCol);
          });

          days.forEach(function (d, i) {
            var x = TIME_GUTTER_W + i * colW;
            var timed = self.eventsOverlapping(d, addDays(d, 1)).filter(function (e) { return !e.allDay; });
            var cols = self._assignOverlapColumns(timed);
            timed.forEach(function (e) {
              var startMin = Math.max(0, (e.start - startOfDay(d)) / 60000);
              var endMin = Math.min(24 * 60, (e.end - startOfDay(d)) / 60000);
              if (endMin <= startMin) endMin = startMin + 30;
              var top = startMin / 60 * HOUR_ROW_H;
              var height = Math.max(16, (endMin - startMin) / 60 * HOUR_ROW_H - 1);
              var slot = cols[e.id];
              var slotW = (colW - 4) / slot.of;
              var block = self._makeEventChip(lively.rect(x + 2 + slot.idx * slotW, top, slotW - 2, height), e, "block");
              scrollBox.addMorph(block);
            });
          });
        },

        // Greedy overlap-column assignment: events sorted by start; each event
        // takes the first column whose previous occupant has already ended,
        // otherwise opens a new column. `of` (columns used by that event's
        // cluster) is resolved as the max column index touched while any
        // event from the same connected cluster was still open.
        _assignOverlapColumns: function (events) {
          var sorted = events.slice().sort(function (a, b) { return a.start - b.start; });
          var colEnds = []; // end time currently occupying each column
          var assigned = {};
          var clusterMembers = [];
          var clusterMaxCol = 0;

          function flushCluster() {
            clusterMembers.forEach(function (e) { assigned[e.id].of = clusterMaxCol + 1; });
            clusterMembers = []; clusterMaxCol = 0; colEnds = [];
          }

          sorted.forEach(function (e) {
            if (clusterMembers.length && e.start >= Math.max.apply(null, colEnds)) flushCluster();
            var placed = false;
            for (var c = 0; c < colEnds.length; c++) {
              if (colEnds[c] <= e.start) { colEnds[c] = e.end; assigned[e.id] = { idx: c, of: 1 }; placed = true; break; }
            }
            if (!placed) { colEnds.push(e.end); assigned[e.id] = { idx: colEnds.length - 1, of: 1 }; }
            clusterMaxCol = Math.max(clusterMaxCol, colEnds.length - 1);
            clusterMembers.push(e);
          });
          flushCluster();
          return assigned;
        },
      },

      "event chips + popover",
      {
        _makeEventChip: function (rect, e, style) {
          var self = this;
          var color = this.colorForEvent(e);
          var chip;
          if (style === "block") {
            chip = box(rect, color, { radius: 3, clip: "hidden", clickable: true });
            var t = fmtTime(e.start);
            chip.addMorph(label(lively.rect(4, 2, rect.width - 8, 14), e.title, { px: 10, color: Color.white, bold: true, wrap: true }));
            if (!e.allDay && rect.height > 28) chip.addMorph(label(lively.rect(4, 15, rect.width - 8, 12), t, { px: 8.5, color: Color.rgba(255, 255, 255, 0.85) }));
          } else {
            chip = box(rect, e.allDay ? color : null, { radius: 3, clip: "hidden", clickable: true });
            var dot = e.allDay ? null : box(lively.rect(2, rect.height / 2 - 3, 6, 6), color, { radius: 3 });
            if (dot) { dot.eventsAreIgnored = true; chip.addMorph(dot); }
            var textX = e.allDay ? 4 : 11;
            var txt = (e.allDay ? "" : fmtTime(e.start).replace(":00 ", " ") + " ") + e.title;
            chip.addMorph(label(lively.rect(textX, 0, rect.width - textX - 2, rect.height), txt, { px: 9.5, color: e.allDay ? Color.white : TEXT_PRIMARY }));
          }
          chip.onMouseUp = function (evt) {
            self._showEventPopover(e, chip);
            evt.stop();
            return true;
          };
          return chip;
        },

        _showEventPopover: function (e, anchorMorph) {
          var self = this;
          this._hidePopover();

          var scrim = box(lively.rect(0, 0, this._w, this._h), Color.rgba(0, 0, 0, 0), { clickable: true });
          scrim.onMouseUp = function (evt) { self._hidePopover(); evt.stop(); return true; };
          this.addMorph(scrim);
          this._scrim = scrim;

          var pw = 260;
          // ph depends on which optional fields this event actually has —
          // computed up front so the Delete button never overlaps a
          // description/attendees line (a fixed ph didn't leave enough
          // room once attendees became a 3rd optional line).
          var y = 56;
          if (e.location) y += 18;
          if (e.attendees && e.attendees.length) y += 18;
          if (e.description) y += 34;
          var ph = y + 44;

          var pos = this.localize(anchorMorph.worldPoint(lively.pt(0, anchorMorph.getExtent().y)));
          var px = Math.min(Math.max(0, pos.x), this._w - pw - 8);
          var py = Math.min(Math.max(HEADER_H, pos.y), this._h - ph - 8);

          var pop = box(lively.rect(px, py, pw, ph), Color.white, { radius: 8, borderWidth: 1, borderColor: BORDER, clip: "hidden", clickable: true });
          var color = this.colorForEvent(e);
          pop.addMorph(box(lively.rect(0, 0, 5, ph), color));
          pop.addMorph(label(lively.rect(16, 12, pw - 56, 20), e.title, { px: 13, bold: true, wrap: true }));
          pop.addMorph(iconButton(lively.rect(pw - 32, 8, 24, 24), "close", function () { self._hidePopover(); }, { px: 16 }));
          var when = e.allDay ? "All day · " + fmtDayTitle(e.start) : fmtDayTitle(e.start) + " · " + fmtTime(e.start) + " – " + fmtTime(e.end);
          pop.addMorph(label(lively.rect(16, 36, pw - 32, 16), when, { px: 10.5, color: TEXT_MUTED }));
          var fieldY = 56;
          if (e.location) { pop.addMorph(label(lively.rect(16, fieldY, pw - 32, 16), "📍 " + e.location, { px: 10.5, color: TEXT_MUTED })); fieldY += 18; }
          if (e.attendees && e.attendees.length) {
            pop.addMorph(label(lively.rect(16, fieldY, pw - 32, 16), "With: " + e.attendees.map(function (h) { return "@" + h; }).join(", "), { px: 10.5, color: TEXT_MUTED, wrap: true }));
            fieldY += 18;
          }
          if (e.description) { pop.addMorph(label(lively.rect(16, fieldY, pw - 32, 32), e.description, { px: 10, color: TEXT_PRIMARY, wrap: true })); }

          pop.addMorph(pillButton(lively.rect(16, ph - 32, 90, 22), "Delete", function () {
            self.deleteEvent(e.id);
            self._hidePopover();
            self._renderMain();
          }, { px: 10, radius: 4, fill: Color.rgb(253, 236, 234), textColor: Color.rgb(197, 48, 48), borderWidth: 0 }));

          this.addMorph(pop);
          this._popover = pop;
        },

        _hidePopover: function () {
          if (this._popover) { this._popover.remove(); this._popover = null; }
          if (this._scrim) { this._scrim.remove(); this._scrim = null; }
        },
      },

      "memo chips + popover",
      {
        _makeMemoChip: function (rect, m, style) {
          var self = this;
          var chip;
          var glyph = m.done ? "check_box" : "check_box_outline_blank";
          var textColor = m.done ? TEXT_MUTED : TEXT_PRIMARY;
          if (style === "block") {
            chip = box(rect, m.done ? MEMO_BG_DONE : MEMO_BG, { radius: 3, clip: "hidden", clickable: true, borderWidth: 1, borderColor: MEMO_BORDER });
            chip.addMorph(iconGlyph(lively.rect(4, rect.height / 2 - 7, 14, 14), glyph, { px: 13, color: MEMO_ACCENT }));
            chip.addMorph(label(lively.rect(20, 2, rect.width - 24, rect.height - 4), m.bodyText || "", { px: 10, color: textColor }));
          } else {
            chip = box(rect, null, { radius: 3, clip: "hidden", clickable: true });
            chip.addMorph(iconGlyph(lively.rect(1, rect.height / 2 - 6, 12, 12), glyph, { px: 11, color: MEMO_ACCENT }));
            chip.addMorph(label(lively.rect(14, 0, rect.width - 16, rect.height), m.bodyText || "", { px: 9.5, color: textColor }));
          }
          chip.onMouseUp = function (evt) {
            self._showMemoPopover(m, chip);
            evt.stop();
            return true;
          };
          return chip;
        },

        _showMemoPopover: function (m, anchorMorph) {
          var self = this;
          this._hidePopover();

          var scrim = box(lively.rect(0, 0, this._w, this._h), Color.rgba(0, 0, 0, 0), { clickable: true });
          scrim.onMouseUp = function (evt) { self._hidePopover(); evt.stop(); return true; };
          this.addMorph(scrim);
          this._scrim = scrim;

          var pw = 280, bodyH = 80;
          var hCalc = 40;
          if (m.tags && m.tags.length) hCalc += 24;
          hCalc += bodyH;
          var ph = hCalc + 44;

          var pos = this.localize(anchorMorph.worldPoint(lively.pt(0, anchorMorph.getExtent().y)));
          var px = Math.min(Math.max(0, pos.x), this._w - pw - 8);
          var py = Math.min(Math.max(HEADER_H, pos.y), this._h - ph - 8);

          var pop = box(lively.rect(px, py, pw, ph), Color.white, { radius: 8, borderWidth: 1, borderColor: BORDER, clip: "hidden", clickable: true });
          pop.addMorph(box(lively.rect(0, 0, 5, ph), MEMO_ACCENT));

          var checkbox = box(lively.rect(16, 12, 18, 18), m.done ? MEMO_ACCENT : Color.white, { borderWidth: 1.5, borderColor: MEMO_ACCENT, radius: 3, clickable: true });
          if (m.done) checkbox.addMorph(iconGlyph(lively.rect(0, -1, 18, 18), "check", { px: 14, color: Color.white }));
          checkbox.onMouseUp = function (evt) {
            self.toggleMemoDone(m.id);
            self._showMemoPopover(self._memoById(m.id), anchorMorph);
            self._renderMain();
            evt.stop(); return true;
          };
          pop.addMorph(checkbox);

          pop.addMorph(label(lively.rect(42, 12, pw - 90, 18), fmtDayTitle(m.date), { px: 11, bold: true, color: TEXT_MUTED }));
          pop.addMorph(iconButton(lively.rect(pw - 32, 8, 24, 24), "close", function () { self._hidePopover(); }, { px: 16 }));

          var fieldY = 40;
          if (m.tags && m.tags.length) {
            var tagsRow = box(lively.rect(16, fieldY, pw - 32, 20), null);
            tagsRow.eventsAreIgnored = true;
            var tx = 0;
            m.tags.forEach(function (tag) {
              var tw = Math.min(100, Math.max(30, 16 + tag.length * 6));
              var pill = box(lively.rect(tx, 0, tw, 18), ACCENT_LIGHT, { radius: 9 });
              pill.addMorph(label(lively.rect(6, 0, tw - 12, 18), tag, { px: 9, color: ACCENT }));
              tagsRow.addMorph(pill);
              tx += tw + 4;
            });
            pop.addMorph(tagsRow);
            fieldY += 24;
          }

          var bodyPreview = new lively.morphic.Text(lively.rect(16, fieldY, pw - 32, bodyH));
          bodyPreview.applyStyle({
            fontSize: 10.5 * 0.75, borderWidth: 0, fill: null,
            allowInput: false, selectable: false, clipMode: "auto",
            // pre-wrap, not normal: "normal" collapses the \n between lines
            // (list items, paragraphs) of a memo into one run-on line
            whiteSpaceHandling: "pre-wrap", textColor: TEXT_PRIMARY,
          });
          noDrag(bodyPreview);
          bodyPreview.eventsAreIgnored = true;
          if (m.bodyMarkup && m.bodyMarkup.length) bodyPreview.setRichTextMarkup(m.bodyMarkup);
          else bodyPreview.textString = m.bodyText || "";
          pop.addMorph(bodyPreview);

          pop.addMorph(pillButton(lively.rect(16, ph - 32, 70, 22), "Edit", function () {
            self._hidePopover();
            self._openMemoDialog(m.date, m);
          }, { px: 10, radius: 4, fill: Color.white }));

          pop.addMorph(pillButton(lively.rect(94, ph - 32, 80, 22), "Delete", function () {
            self.deleteMemo(m.id);
            self._hidePopover();
            self._renderMain();
          }, { px: 10, radius: 4, fill: Color.rgb(253, 236, 234), textColor: Color.rgb(197, 48, 48), borderWidth: 0 }));

          this.addMorph(pop);
          this._popover = pop;
        },
      },

      "add-event dialog",
      {
        _openAddEventDialog: function (prefillDate) {
          var self = this;
          this._hidePopover();
          this._closeDialog();

          var scrim = box(lively.rect(0, 0, this._w, this._h), Color.rgba(0, 0, 0, 0.2), { clickable: true });
          scrim.onMouseUp = function (evt) { self._closeDialog(); evt.stop(); return true; };
          this.addMorph(scrim);
          this._scrim = scrim;

          var dw = 340, dh = 632;
          var dlgY = Math.max(8, (this._h - dh) / 2);
          var dlg = box(lively.rect((this._w - dw) / 2, dlgY, dw, dh), Color.white, { radius: 10, borderWidth: 1, borderColor: BORDER, clip: "auto", clickable: true });
          this.addMorph(dlg);
          this._dialog = dlg;

          dlg.addMorph(label(lively.rect(20, 16, dw - 60, 22), "New event", { px: 15, bold: true }));
          dlg.addMorph(iconButton(lively.rect(dw - 40, 12, 26, 26), "close", function () { self._closeDialog(); }, { px: 17 }));

          var titleField = textInput(lively.rect(20, 50, dw - 40, 32), "");
          dlg.addMorph(titleField);
          this._refs.dlgTitle = titleField;

          dlg.addMorph(label(lively.rect(20, 92, 60, 16), "Date", { px: 10, color: TEXT_MUTED }));
          var dateField = textInput(lively.rect(20, 110, 130, 28), fmtYMD(prefillDate || this.currentDate));
          dlg.addMorph(dateField);
          this._refs.dlgDate = dateField;

          var allDayBox = box(lively.rect(160, 114, 18, 18), Color.white, { borderWidth: 1.5, borderColor: BORDER, radius: 3, clickable: true });
          dlg.addMorph(allDayBox);
          var allDayLabel = label(lively.rect(184, 112, 100, 18), "All day", { px: 10.5 });
          dlg.addMorph(allDayLabel);
          this._refs.dlgAllDay = allDayBox;
          this._refs.dlgAllDayChecked = false;
          allDayBox.onMouseUp = function (evt) {
            self._refs.dlgAllDayChecked = !self._refs.dlgAllDayChecked;
            allDayBox.removeAllMorphs();
            allDayBox.applyStyle({ fill: self._refs.dlgAllDayChecked ? ACCENT : Color.white, borderColor: self._refs.dlgAllDayChecked ? ACCENT : BORDER });
            if (self._refs.dlgAllDayChecked) allDayBox.addMorph(iconGlyph(lively.rect(0, -1, 18, 18), "check", { px: 14, color: Color.white }));
            evt.stop(); return true;
          };

          dlg.addMorph(label(lively.rect(20, 150, 60, 16), "Start", { px: 10, color: TEXT_MUTED }));
          dlg.addMorph(label(lively.rect(190, 150, 60, 16), "End", { px: 10, color: TEXT_MUTED }));
          var startField = textInput(lively.rect(20, 168, 130, 28), "09:00");
          var endField = textInput(lively.rect(190, 168, 130, 28), "10:00");
          dlg.addMorph(startField); dlg.addMorph(endField);
          this._refs.dlgStart = startField; this._refs.dlgEnd = endField;

          dlg.addMorph(label(lively.rect(20, 208, 60, 16), "Location", { px: 10, color: TEXT_MUTED }));
          var locField = textInput(lively.rect(20, 226, dw - 40, 28), "");
          dlg.addMorph(locField);
          this._refs.dlgLocation = locField;

          dlg.addMorph(label(lively.rect(20, 266, 80, 16), "Description", { px: 10, color: TEXT_MUTED }));
          var descField = textInput(lively.rect(20, 284, dw - 40, 50), "", { multiline: true });
          dlg.addMorph(descField);
          this._refs.dlgDescription = descField;

          dlg.addMorph(label(lively.rect(20, 344, 80, 16), "Calendar", { px: 10, color: TEXT_MUTED }));
          this._refs.dlgCalendarId = this.calendars[0].id;
          var swx = 20;
          this.calendars.forEach(function (cal) {
            var sw = box(lively.rect(swx, 362, 20, 20), cal.color, { radius: 4, borderWidth: cal.id === self._refs.dlgCalendarId ? 2 : 0, borderColor: Color.black, clickable: true });
            sw.onMouseUp = (function (id, swatch) {
              return function (evt) {
                self._refs.dlgCalendarId = id;
                dlg.submorphs.forEach(function (m) { if (m._isCalSwatch) m.applyStyle({ borderWidth: 0 }); });
                swatch.applyStyle({ borderWidth: 2, borderColor: Color.black });
                evt.stop(); return true;
              };
            })(cal.id, sw);
            sw._isCalSwatch = true;
            dlg.addMorph(sw);
            swx += 26;
          });

          // ─── Friends (search + tag; defaults from sidebar's tagged friends) ───
          dlg.addMorph(label(lively.rect(20, 392, 80, 16), "Friends", { px: 10, color: TEXT_MUTED }));
          this._dlgSelectedAttendees = this.taggedFriendHandles.slice();

          var chipsBox = box(lively.rect(20, 410, dw - 40, 48), null, { clip: "hidden" });
          dlg.addMorph(chipsBox);
          this._refs.dlgChipsBox = chipsBox;

          var friendsSearchField = textInput(lively.rect(20, 464, dw - 40, 26), "");
          friendsSearchField.applyStyle({ fontSize: 10 * 0.75 });
          dlg.addMorph(friendsSearchField);
          this._refs.dlgFriendsSearch = friendsSearchField;
          var origDlgFriendsOnKeyUp = friendsSearchField.onKeyUp.bind(friendsSearchField);
          friendsSearchField.onKeyUp = function (evt) {
            var result = origDlgFriendsOnKeyUp(evt);
            self._renderDialogFriendsSection();
            return result;
          };

          var resultsBox = box(lively.rect(20, 496, dw - 40, 84), Color.rgb(250, 250, 251), { borderWidth: 1, borderColor: BORDER_LIGHT, radius: 4, clip: "auto" });
          dlg.addMorph(resultsBox);
          this._refs.dlgResultsBox = resultsBox;

          this._renderDialogFriendsSection();

          dlg.addMorph(pillButton(lively.rect(dw - 168, dh - 44, 76, 30), "Cancel", function () { self._closeDialog(); }, { fill: Color.white }));
          dlg.addMorph(pillButton(lively.rect(dw - 86, dh - 44, 66, 30), "Save", function () { self._saveDialogEvent(); }, { fill: ACCENT, textColor: Color.white, borderWidth: 0 }));

          titleField.focus && titleField.focus();
        },

        // Rebuilds only the chips row + results list (not the search input
        // itself, which stays live so typing doesn't lose focus/cursor).
        _renderDialogFriendsSection: function () {
          var self = this;
          var chipsBox = this._refs.dlgChipsBox, resultsBox = this._refs.dlgResultsBox;
          if (!chipsBox || !resultsBox) return;
          chipsBox.removeAllMorphs();
          resultsBox.removeAllMorphs();

          var selected = this._dlgSelectedAttendees;
          var chipH = 22, gap = 6, x = 0, y = 0, maxW = chipsBox.getExtent().x;
          selected.forEach(function (handle) {
            var w = Math.min(140, Math.max(66, 30 + handle.length * 7));
            if (x + w > maxW && x > 0) { x = 0; y += chipH + 4; }
            var chip = box(lively.rect(x, y, w, chipH), ACCENT_LIGHT, { radius: chipH / 2 });
            chip.addMorph(label(lively.rect(8, 0, w - 26, chipH), "@" + handle, { px: 10, color: ACCENT }));
            chip.addMorph(iconButton(lively.rect(w - 20, 2, 18, 18), "close", function () {
              var idx = self._dlgSelectedAttendees.indexOf(handle);
              if (idx !== -1) self._dlgSelectedAttendees.splice(idx, 1);
              self._renderDialogFriendsSection();
            }, { px: 13, color: ACCENT }));
            chipsBox.addMorph(chip);
            x += w + gap;
          });

          var signedIn = typeof lively !== "undefined" && lively.identity && lively.identity.did &&
            lively.identity.did.isLoggedIn && lively.identity.did.isLoggedIn();
          if (!signedIn) {
            resultsBox.addMorph(label(lively.rect(6, 6, resultsBox.getExtent().x - 12, 32), "Sign in to tag friends.", { px: 10, color: TEXT_MUTED, wrap: true }));
            return;
          }
          var query = (this._refs.dlgFriendsSearch.textString || "").trim().toLowerCase();
          var candidates = this.friends.filter(function (f) {
            return selected.indexOf(f.handle) === -1 && (!query || (f.handle || "").toLowerCase().indexOf(query) !== -1);
          });
          if (!candidates.length) {
            resultsBox.addMorph(label(lively.rect(6, 6, resultsBox.getExtent().x - 12, 32),
              this.friends.length ? "No matches." : "No friends yet.", { px: 10, color: TEXT_MUTED }));
            return;
          }
          var rowH = 24;
          candidates.forEach(function (f, i) {
            var row = self._makeFriendRow(lively.rect(0, i * rowH, resultsBox.getExtent().x, rowH), f, function (friend) {
              self._dlgSelectedAttendees.push(friend.handle);
              self._renderDialogFriendsSection();
            });
            resultsBox.addMorph(row);
          });
        },

        _saveDialogEvent: function () {
          var r = this._refs;
          var title = (r.dlgTitle.textString || "").trim();
          var date = parseYMD(r.dlgDate.textString);
          if (!title) { r.dlgTitle.applyStyle({ borderColor: Color.red }); return; }
          if (!date) { r.dlgDate.applyStyle({ borderColor: Color.red }); return; }

          var allDay = r.dlgAllDayChecked;
          var start, end;
          if (allDay) {
            start = startOfDay(date);
            end = addDays(start, 1);
          } else {
            var st = parseHHMM(r.dlgStart.textString) || { h: 9, m: 0 };
            var et = parseHHMM(r.dlgEnd.textString) || { h: 10, m: 0 };
            start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), st.h, st.m);
            end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), et.h, et.m);
            if (end <= start) end = new Date(start.getTime() + 3600000);
          }

          this.addManualEvent({
            title: title, start: start, end: end, allDay: allDay,
            location: r.dlgLocation.textString, description: r.dlgDescription.textString,
            calendarId: r.dlgCalendarId, attendees: this._dlgSelectedAttendees.slice(),
          });
          this._closeDialog();
          this.goToDate(date);
        },

        _closeDialog: function () {
          if (this._dialog) { this._dialog.remove(); this._dialog = null; }
          if (this._scrim) { this._scrim.remove(); this._scrim = null; }
        },
      },

      "create chooser",
      {
        // Shown from the "+ Create" button, a mini-calendar day click, and
        // an empty Month/Week/Day cell click — asks Memo-or-Event before
        // handing off to that content type's own dialog, prefilled with
        // whichever day was clicked.
        _openCreateChooser: function (prefillDate) {
          var self = this;
          this._hidePopover();
          this._closeDialog();
          this._closeChooser();

          var scrim = box(lively.rect(0, 0, this._w, this._h), Color.rgba(0, 0, 0, 0.2), { clickable: true });
          scrim.onMouseUp = function (evt) { self._closeChooser(); evt.stop(); return true; };
          this.addMorph(scrim);
          this._scrim = scrim;

          var cw = 300, ch = 190;
          var cx = (this._w - cw) / 2, cy = Math.max(8, (this._h - ch) / 2);
          var chooser = box(lively.rect(cx, cy, cw, ch), Color.white, { radius: 10, borderWidth: 1, borderColor: BORDER, clip: "hidden", clickable: true });
          this.addMorph(chooser);
          this._chooser = chooser;

          chooser.addMorph(label(lively.rect(20, 16, cw - 60, 22), "Create new…", { px: 14, bold: true }));
          chooser.addMorph(iconButton(lively.rect(cw - 40, 12, 26, 26), "close", function () { self._closeChooser(); }, { px: 17 }));

          var optW = cw - 40, optH = 56;

          var memoOpt = box(lively.rect(20, 54, optW, optH), Color.white, { radius: 8, borderWidth: 1.5, borderColor: MEMO_BORDER, clickable: true });
          memoOpt.addMorph(iconGlyph(lively.rect(14, (optH - 26) / 2, 26, 26), "event_note", { px: 22, color: MEMO_ACCENT }));
          memoOpt.addMorph(label(lively.rect(50, (optH - 18) / 2, optW - 60, 18), "Memo", { px: 12.5, bold: true }));
          memoOpt.onMouseOver = function () { memoOpt.applyStyle({ fill: MEMO_BG }); };
          memoOpt.onMouseOut = function () { memoOpt.applyStyle({ fill: Color.white }); };
          memoOpt.onMouseUp = function (evt) { self._closeChooser(); self._openMemoDialog(prefillDate); evt.stop(); return true; };
          chooser.addMorph(memoOpt);

          var eventOpt = box(lively.rect(20, 54 + optH + 12, optW, optH), Color.white, { radius: 8, borderWidth: 1.5, borderColor: BORDER, clickable: true });
          eventOpt.addMorph(iconGlyph(lively.rect(14, (optH - 26) / 2, 26, 26), "event", { px: 22, color: ACCENT }));
          eventOpt.addMorph(label(lively.rect(50, (optH - 18) / 2, optW - 60, 18), "Event", { px: 12.5, bold: true }));
          eventOpt.onMouseOver = function () { eventOpt.applyStyle({ fill: ACCENT_LIGHT }); };
          eventOpt.onMouseOut = function () { eventOpt.applyStyle({ fill: Color.white }); };
          eventOpt.onMouseUp = function (evt) { self._closeChooser(); self._openAddEventDialog(prefillDate); evt.stop(); return true; };
          chooser.addMorph(eventOpt);
        },

        _closeChooser: function () {
          if (this._chooser) { this._chooser.remove(); this._chooser = null; }
          if (this._scrim) { this._scrim.remove(); this._scrim = null; }
        },
      },

      "add-memo dialog",
      {
        _openMemoDialog: function (prefillDate, existingMemo) {
          var self = this;
          this._hidePopover();
          this._closeDialog();
          this._closeChooser();

          var scrim = box(lively.rect(0, 0, this._w, this._h), Color.rgba(0, 0, 0, 0.2), { clickable: true });
          scrim.onMouseUp = function (evt) { self._closeDialog(); evt.stop(); return true; };
          this.addMorph(scrim);
          this._scrim = scrim;

          var dw = 360, dh = 460;
          var dlgY = Math.max(8, (this._h - dh) / 2);
          var dlg = box(lively.rect((this._w - dw) / 2, dlgY, dw, dh), Color.white, { radius: 10, borderWidth: 1, borderColor: BORDER, clip: "auto", clickable: true });
          this.addMorph(dlg);
          this._dialog = dlg;
          this._dlgEditingMemoId = existingMemo ? existingMemo.id : null;

          dlg.addMorph(label(lively.rect(20, 16, dw - 60, 22), existingMemo ? "Edit memo" : "New memo", { px: 15, bold: true }));
          dlg.addMorph(iconButton(lively.rect(dw - 40, 12, 26, 26), "close", function () { self._closeDialog(); }, { px: 17 }));

          dlg.addMorph(label(lively.rect(20, 50, 60, 16), "Date", { px: 10, color: TEXT_MUTED }));
          var dateField = textInput(lively.rect(20, 68, 130, 28), fmtYMD((existingMemo && existingMemo.date) || prefillDate || this.currentDate));
          dlg.addMorph(dateField);
          this._refs.memoDlgDate = dateField;

          dlg.addMorph(label(lively.rect(20, 108, 80, 16), "Note", { px: 10, color: TEXT_MUTED }));
          var bodyField = new lively.morphic.Text(lively.rect(20, 126, dw - 40, 220));
          bodyField.applyStyle({
            fontSize: 11 * 0.75, // real 11px — fontSize renders as pt, not px (see CLAUDE.md)
            fill: Color.rgb(248, 249, 250),
            borderWidth: 1, borderColor: BORDER, borderRadius: 4,
            padding: lively.rect(8, 6, 0, 0),
            textColor: TEXT_PRIMARY,
            // pre-wrap, not normal: Enter inserts a "\n" character, which
            // "normal" renders as a space, so lines ran together
            whiteSpaceHandling: "pre-wrap",
            clipMode: "auto",
          });
          noDrag(bodyField);
          // enableFormattingToolbar comes from lively.morphic.TextFormattingSupport
          // (added directly onto Text's own prototype, not a subclass — see
          // that file's header comment) and shows/hides the shared
          // lively.morphic.TextFormattingToolbar singleton on focus/blur.
          bodyField.enableFormattingToolbar && bodyField.enableFormattingToolbar();
          if (existingMemo && existingMemo.bodyMarkup && existingMemo.bodyMarkup.length) bodyField.setRichTextMarkup(existingMemo.bodyMarkup);
          else bodyField.textString = (existingMemo && existingMemo.bodyText) || "";
          dlg.addMorph(bodyField);
          this._refs.memoDlgBody = bodyField;

          dlg.addMorph(label(lively.rect(20, 356, 200, 16), "Tags (comma-separated)", { px: 10, color: TEXT_MUTED }));
          var tagsField = textInput(lively.rect(20, 374, dw - 40, 28), ((existingMemo && existingMemo.tags) || []).join(", "));
          dlg.addMorph(tagsField);
          this._refs.memoDlgTags = tagsField;

          dlg.addMorph(pillButton(lively.rect(dw - 168, dh - 44, 76, 30), "Cancel", function () { self._closeDialog(); }, { fill: Color.white }));
          dlg.addMorph(pillButton(lively.rect(dw - 86, dh - 44, 66, 30), "Save", function () { self._saveDialogMemo(); }, { fill: ACCENT, textColor: Color.white, borderWidth: 0 }));

          bodyField.focus && bodyField.focus();
        },

        _saveDialogMemo: function () {
          var r = this._refs;
          var date = parseYMD(r.memoDlgDate.textString);
          if (!date) { r.memoDlgDate.applyStyle({ borderColor: Color.red }); return; }

          var bodyMarkup = r.memoDlgBody.getRichTextMarkup();
          var bodyText = r.memoDlgBody.textString || "";
          var tagsRaw = (r.memoDlgTags.textString || "").trim();
          var tags = tagsRaw ? tagsRaw.split(",").map(function (t) { return t.trim(); }).filter(Boolean) : [];

          if (this._dlgEditingMemoId) {
            this.updateMemo(this._dlgEditingMemoId, { date: date, bodyMarkup: bodyMarkup, bodyText: bodyText, tags: tags });
          } else {
            this.addManualMemo({ date: date, bodyMarkup: bodyMarkup, bodyText: bodyText, tags: tags });
          }
          this._dlgEditingMemoId = null;
          this._closeDialog();
          this.goToDate(date);
        },
      },

      "import",
      {
        _promptImportFile: function () {
          var self = this;
          var input = document.createElement("input");
          input.type = "file";
          input.accept = ".ics,.vcs,.csv,text/calendar,text/csv";
          input.style.display = "none";
          document.body.appendChild(input);
          input.addEventListener("change", function () {
            var file = input.files && input.files[0];
            if (input.parentNode) input.parentNode.removeChild(input);
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function () { self._handleImportedText(String(reader.result), file.name); };
            reader.onerror = function () { $world.alert("Could not read file: " + file.name); };
            reader.readAsText(file);
          });
          input.click();
        },

        _handleImportedText: function (text, fileName) {
          var parsed;
          try {
            parsed = lively.calendar.CalendarImport.parseFile(text, fileName);
          } catch (err) {
            $world.alert("Failed to parse " + fileName + ": " + err.message);
            return;
          }
          if (!parsed.events.length) {
            $world.alert("No events found in " + fileName + ".");
            return;
          }
          var name = parsed.calendarName || fileName.replace(/\.[^.]+$/, "");
          var colorIdx = this.calendars.length;
          this.addCalendarFromImport(name, parsed.events, colorIdx);
          this._renderSidebar();
          this._renderMain();
          $world.setStatusMessage && $world.setStatusMessage("Imported " + parsed.events.length + " event(s) from " + fileName, Color.green, 4);
        },
      },
    );

    CalendarAppClass.open = function (optPos) {
      var m = new lively.calendar.CalendarApp(lively.rect(0, 0, APP_W, APP_H));
      m.setName("Calendar");
      m.openInWindow({ title: "Calendar", pos: optPos || lively.morphic.World.current().visibleBounds().center().subPt(lively.pt(APP_W / 2, APP_H / 2)) });
      return m;
    };

  }); // end module('lively.calendar.CalendarApp')
