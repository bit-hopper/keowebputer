/**
 * lively.gaming.GameDialogs
 *
 * The three dialogs of the Gaming template, each opened over the library through
 * GamingUI.openModal (a dim layer fixed to the viewport with a panel on it):
 *   openAdd(host)               search a game database (or type a title) and add games
 *   openDetail(host, entry)     one game: its facts, and, for the owner, the person's own take
 *   openVisibility(host, entry) who can see one game
 * `host` is the lively.gaming.Gaming morph: every write goes through host.saveEntry /
 * addGame / removeEntry, never straight to the data layer, so saves for one game are
 * queued and the library on screen stays in step.
 *
 * Two kinds of fact are kept visibly apart in the detail dialog (the core visual idea of
 * the template): IMPORTED facts (title, cover, platforms, playtime a service supplied,
 * when it last synced) sit in a neutral panel with a dashed border, a sync icon and their
 * source named, and are read-only; PERSONAL facts (status, rating, review, who can see it,
 * playtime typed by hand) sit in a panel with the accent border and are editable. Playtime
 * is never shown without its source.
 *
 * Re-render rule: a click handler never rebuilds the morph that received the click while it
 * is still handling it. Controls that change on a click are rebuilt one tick later.
 */

module("lively.gaming.GameDialogs")
  .requires("lively.morphic.Complete", "lively.gaming.GamingUI", "lively.gaming.GameLog")
  .toRun(function () {

    var UI = function () { return lively.gaming.GamingUI; };
    var IGDB = "/nodejs/GameDbProxyServer/";

    var SOURCE_LABEL = {
      igdb: "Game data from IGDB", steam: "Imported from Steam", itch: "Imported from itch.io",
    };

    // ─── small builders shared by the dialogs ────────────────────────────────

    // A Box that owns a click, with a role and a name. `build(box)` adds its children.
    // opts: { fill, radius, border, role, label, pressed, disabled, onClick }.
    function clickBox(rect, opts, build) {
      var b = UI().box(rect, opts.fill, { radius: opts.radius || 0, border: opts.border, borderWidth: opts.borderWidth });
      if (build) build(b);
      if (opts.disabled) {
        UI().makeInteractive(b, { role: opts.role || "button", label: opts.label, disabled: true });
        return b;
      }
      b.onMouseUp = function (evt) { evt.stop(); if (opts.onClick) opts.onClick(b); return true; };
      UI().makeInteractive(b, { role: opts.role || "button", label: opts.label, pressed: opts.pressed, onActivate: function () { if (opts.onClick) opts.onClick(b); } });
      return b;
    }

    // The round "x" at a dialog's top-right corner.
    function closeButton(m, x, y) {
      var th = UI().theme();
      var b = clickBox(lively.rect(x, y, 30, 30), { radius: 15, label: "Close", onClick: function () { m.close(); } }, function (box) {
        box.addMorph(UI().icon(lively.rect(0, 4, 30, 24), "close", 20, th.muted));
      });
      return b;
    }

    // A cover: the real art when there is a url, else a stable gradient with the game's initial.
    // Returns a clipped, rounded Box of the given size.
    function coverBox(rect, payload, radius) {
      var ui = UI(), c = ui.coverColors(payload.title);
      var b = ui.box(rect, null, { radius: radius || 8 });
      b.applyStyle({ fill: ui.gradient(c.a, c.b) });
      var initial = ui.label(lively.rect(0, Math.round(rect.height / 2 - rect.height * 0.14), rect.width, Math.round(rect.height * 0.3)),
        (String(payload.title || "?").trim().charAt(0) || "?").toUpperCase(), { px: Math.round(rect.height * 0.3), font: "display", color: Color.rgba(255, 255, 255, 0.85), align: "center" });
      b.addMorph(initial);
      if (payload.cover_url) {
        var img = new lively.morphic.Image(lively.rect(0, 0, rect.width, rect.height), payload.cover_url);
        ui.noDrag(img); img.eventsAreIgnored = true;
        b.addMorph(img);
        var el = img.renderContext().shapeNode.querySelector("img");
        if (el) {
          el.addEventListener("load", function () { if (el.naturalWidth) initial.setVisible(false); });
          el.addEventListener("error", function () { img.setVisible(false); });
        }
      }
      return b;
    }

    function hoursText(minutes) {
      if (minutes == null) return "";
      var h = minutes / 60;
      return String(h >= 10 ? Math.round(h) : Math.round(h * 10) / 10);
    }

    function dateText(iso) {
      if (!iso) return "";
      try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); } catch (e) { return ""; }
    }

    function activityFor(status) {
      return { kind: status === "completed" ? "finished" : status === "playing" ? "started" : "added", at: new Date().toISOString() };
    }

    var VIS_OPTIONS = [
      { key: "private", icon: "lock", label: "Private", enabled: true,
        text: "Only you. The game is encrypted: nobody else, and not even this server, can read it." },
      { key: "shared", icon: "group", label: "Friends", enabled: true,
        text: "People you choose: your friends, your orbit, a list, or specific people. Encrypted so that only they can open it." },
      { key: "public", icon: "public", label: "Public", enabled: true,
        text: "Anyone can read it. NOT encrypted: everything in this entry, including your review and playtime, is public." },
    ];

    lively.gaming.GameDialogs = {

      // The small builders above, shared with the other dialogs (the import preview) so that a
      // change to how a dialog's click box, close button or cover looks is made once. Same
      // contracts as where they are defined; reach them by this dotted path, never by copying.
      clickBox: clickBox,
      closeButton: closeButton,
      coverBox: coverBox,

      // ─── who can see one game ──────────────────────────────────────────────

      // A small dialog with the three choices. Choosing one saves at once and says so.
      openVisibility: function (host, entry) {
        var ui = UI(), th = ui.theme();
        var W = 420, H = 80 + VIS_OPTIONS.length * 74 + 24;
        var m = ui.openModal({ host: host, w: W, h: H, label: "Who can see " + entry.payload.title });
        var p = m.panel;
        p.addMorph(ui.label(lively.rect(24, 22, W - 90, 28), "Who can see this game?", { px: 18, font: "display" }));
        var closeB = closeButton(m, W - 52, 18); p.addMorph(closeB);
        p.addMorph(ui.label(lively.rect(24, 52, W - 48, 18), ui.trunc(entry.payload.title, 50), { px: 13, color: th.muted }));
        VIS_OPTIONS.forEach(function (o, i) {
          var on = entry.visibility === o.key, y = 84 + i * 74;
          var row = clickBox(lively.rect(20, y, W - 40, 66), {
            fill: on ? th.accentSoft : null, radius: 12, border: on ? th.accent : th.line, role: "radio", pressed: on,
            label: o.label + ". " + o.text, disabled: !o.enabled,
            onClick: function () {
              m.close();
              // Sharing needs to know WITH WHOM, so it goes through the audience dialog (also
              // when it is already selected: that is how the audience is edited).
              if (o.key === "shared") return host.chooseAudience(entry);
              if (!on) host.saveEntry(entry, { visibility: o.key }, function (err) { if (!err) host.toast(ui.trunc(entry.payload.title, 30) + " is now " + o.label.toLowerCase()); });
            },
          }, function (box) {
            box.addMorph(ui.icon(lively.rect(12, 10, 28, 28), o.icon, 22, o.enabled ? (on ? th.accent : th.muted) : th.line));
            var name = ui.label(lively.rect(0, 0, 200, 20), o.label, { px: 14, bold: true, color: o.enabled ? th.text : th.muted });
            box.addMorph(name); name.setPosition(lively.pt(50, 8));
            var t = ui.label(lively.rect(0, 0, W - 40 - 62, 36), o.text, { px: 12, color: th.muted, wrap: true });
            box.addMorph(t); t.setPosition(lively.pt(50, 28));
          });
          p.addMorph(row);
        });
        return m;
      },

      // ─── share as a postcard ───────────────────────────────────────────────

      // Chooses what a postcard about one game carries, then opens the postcard editor with it
      // filled in: the game block, an opening line (and the review, if any) as text, and the
      // owner's Friends as the audience. Nothing is created here and nothing is sent: the card
      // exists only once its author edits or saves it in the editor, where the words and the
      // audience can still be changed.
      //   Show my rating    on by default when the game is rated; unavailable when it is not
      //   Show my playtime  off by default (playtime a store supplied counts as imported
      //                     data and stays out unless the owner opts in); unavailable when
      //                     there is none
      // The review is not an option here: it goes into the card's text, where it is visible
      // and editable, rather than being attached invisibly.
      openShare: function (host, entry0) {
        var ui = UI(), th = ui.theme(), GL = lively.gaming.GameLog;
        var W = 480, H = 424;
        var cur = function () { return host.entryById(entry0.objId) || entry0; };
        var pl0 = cur().payload;
        var pt = GL.playtimeOf(pl0);
        var s = { rating: (pl0.rating || 0) > 0, playtime: false };
        var m = ui.openModal({ host: host, w: W, h: H, label: "Share " + pl0.title + " as a postcard" });
        var p = m.panel;
        p.addMorph(ui.label(lively.rect(24, 22, W - 90, 28), "Share as a postcard", { px: 20, font: "display" }));
        p.addMorph(closeButton(m, W - 52, 18));

        p.addMorph(coverBox(lively.rect(24, 66, 64, 86), pl0, 8));
        var name = ui.label(lively.rect(0, 0, W - 124 - 24, 24), ui.fit(pl0.title, 16, 700, W - 124 - 24 - 10), { px: 16, bold: true });
        p.addMorph(name); name.setPosition(lively.pt(104, 70));
        p.addMorph(ui.statusPill(104, 102, pl0.status));
        var sub = ui.label(lively.rect(0, 0, W - 124 - 24, 18), ui.fit([pl0.year, pl0.genre].filter(Boolean).join(" · "), 12, 400, W - 124 - 24 - 10), { px: 12, color: th.muted });
        p.addMorph(sub); sub.setPosition(lively.pt(104, 130));

        var lab = ui.label(lively.rect(0, 0, W - 48, 16), "WHAT THE POSTCARD SHOWS", { px: 11, bold: true, color: th.muted });
        p.addMorph(lab); lab.setPosition(lively.pt(24, 170));
        var rowsBox = ui.box(lively.rect(0, 192, W, 100), null, { clip: false });
        rowsBox.eventsAreIgnored = false;
        p.addMorph(rowsBox);

        // One checkbox row. key: "rating" | "playtime"; note: why it is unavailable (or null).
        function checkRow(y, key, text, note) {
          var on = !note && s[key], off = !!note;
          var row = clickBox(lively.rect(20, y, W - 40, 44), {
            radius: 10, border: on ? th.accent : th.line, fill: on ? th.accentSoft : null, role: "checkbox", pressed: on, disabled: off,
            label: text + (note ? " (" + note + ")" : ""),
            onClick: function () { s[key] = !s[key]; setTimeout(renderRows, 0); },
          }, function (box) {
            var sq = ui.box(lively.rect(12, 12, 20, 20), on ? th.accent : null, { radius: 6, border: on ? th.accent : th.muted, borderWidth: 2 });
            sq.eventsAreIgnored = true;
            if (on) sq.addMorph(ui.icon(lively.rect(0, 0, 16, 16), "check", 14, th.onAccent));
            box.addMorph(sq);
            var t = ui.label(lively.rect(0, 0, W - 40 - 56, 20), text, { px: 14, weight: 600, color: off ? th.muted : th.text });
            box.addMorph(t); t.setPosition(lively.pt(44, 6));
            var n = ui.label(lively.rect(0, 0, W - 40 - 56, 16), note || (key === "rating" ? ui.starsText(pl0.rating) : (pt.minutes != null ? GL_hours(pt.minutes) + " · " + (pt.source === "manual" ? "typed by you" : "from the store") : "")), { px: 11, color: th.muted });
            box.addMorph(n); n.setPosition(lively.pt(44, 24));
          });
          return row;
        }
        function GL_hours(minutes) { return hoursText(minutes) + " h"; }
        function renderRows() {
          rowsBox.submorphs.slice().forEach(function (c) { c.remove(); });
          rowsBox.addMorph(checkRow(0, "rating", "Show my rating", (pl0.rating || 0) > 0 ? null : "you have not rated it"));
          rowsBox.addMorph(checkRow(52, "playtime", "Show my playtime", pt.minutes != null ? null : "no playtime recorded"));
        }
        renderRows();

        var note = ui.label(lively.rect(0, 0, W - 48, 54), "Your friends will be able to read this postcard. You can reword it, change who can see it, or close the editor without sending anything.", { px: 12, color: th.muted, wrap: true });
        p.addMorph(note); note.setPosition(lively.pt(24, 302));

        var cancel = ui.button(0, H - 56, "Cancel", { variant: "secondary", onClick: function () { m.close(); } });
        var go = ui.button(0, H - 56, "Open postcard", { variant: "primary", icon: "mail", onClick: function () {
          var e = cur(), user = lively.identity.did.currentUser();
          if (!user) return;
          var game = GL.shareBlock(e.payload, s), text = GL.shareText(e.payload);
          m.close();
          lively.require("lively.identity.PostCardEditor").toRun(function () {
            lively.identity.PostCardEditor.newCard(user.handle, { game: game, text: text, audience: { tiers: ["friends"], people: [] } });
          });
        } });
        go.setPosition(lively.pt(W - 24 - go.getExtent().x, H - 56));
        cancel.setPosition(lively.pt(W - 24 - go.getExtent().x - 8 - cancel.getExtent().x, H - 56));
        p.addMorph(cancel); p.addMorph(go);
        return m;
      },

      // ─── one game ──────────────────────────────────────────────────────────

      openDetail: function (host, entry0) {
        var ui = UI(), th = ui.theme();
        var owner = host.isOwner();
        var W = 780, H = owner ? 624 : 480;
        var d = { entry: entry0, timer: null, confirming: false };
        // the entry as currently stored (a save replaces the object); always read through here
        function cur() { return host.entryById(d.entry.objId) || d.entry; }
        function P() { return cur().payload; }

        var m = ui.openModal({
          host: host, w: W, h: H, label: "Game: " + entry0.payload.title,
          onClose: function () { flush(); clearTimeout(d.timer); },
        });
        var p = m.panel;

        // Writes the typed fields (review, own playtime) now, if they changed. Called by the
        // autosave timer, on Enter in the hours field, and when the dialog closes any way.
        function flush() {
          clearTimeout(d.timer);
          if (!owner || !host.entryById(d.entry.objId)) return;
          var ch = {};
          if (d.review && d.review.getValue() !== (P().review || "")) ch.review = d.review.getValue();
          if (d.hours) {
            var raw = d.hours.getValue().trim().replace(",", "."), mins = null, bad = false;
            if (raw !== "") { var hrs = parseFloat(raw); if (isFinite(hrs) && hrs >= 0) mins = Math.round(hrs * 60); else bad = true; }
            var stored = P().manual_playtime_minutes == null ? null : P().manual_playtime_minutes;
            if (!bad && mins !== stored) ch.manual_playtime_minutes = mins;
          }
          if (Object.keys(ch).length) host.saveEntry(d.entry, ch);
        }
        function later() { clearTimeout(d.timer); d.timer = setTimeout(flush, 1200); }   // autosave shortly after typing stops

        // ── header and cover
        var pl = P();
        p.addMorph(closeButton(m, W - 52, 14));
        p.addMorph(coverBox(lively.rect(24, 24, 190, 254), pl, 12));
        var title = ui.label(lively.rect(0, 0, W - 238 - 60, 30), ui.fit(pl.title, 22, 400, W - 238 - 60 - 10, "display"), { px: 22, font: "display" });
        p.addMorph(title); title.setPosition(lively.pt(238, 22));
        var sub = ui.label(lively.rect(0, 0, W - 238 - 24, 18), ui.fit([pl.year, pl.genre, pl.studio].filter(Boolean).join(" · ") || "No details recorded", 13, 400, W - 238 - 24 - 10), { px: 13, color: th.muted });
        p.addMorph(sub); sub.setPosition(lively.pt(238, 58));

        // ── imported panel: neutral, dashed, source named, read-only
        var pw = W - 238 - 24;
        var imp = ui.box(lively.rect(238, 88, pw, 130), th.impBg, { radius: 12, border: th.line });
        p.addMorph(imp);
        imp.renderContext().shapeNode.style.borderStyle = "dashed";
        imp.addMorph(ui.icon(lively.rect(12, 10, 20, 20), "sync", 16, th.muted));
        var srcName = SOURCE_LABEL[pl.cover_source] || (pl.igdb_id ? SOURCE_LABEL.igdb : "Added by hand");
        var srcLabel = ui.label(lively.rect(0, 0, pw - 60, 16), srcName.toUpperCase(), { px: 11, bold: true, color: th.muted });
        imp.addMorph(srcLabel); srcLabel.setPosition(lively.pt(36, 12));
        function line(y, name, value) {
          var a = ui.label(lively.rect(0, 0, 150, 18), name, { px: 12, color: th.muted });
          imp.addMorph(a); a.setPosition(lively.pt(14, y));
          if (value == null) return;
          var v = ui.label(lively.rect(0, 0, pw - 170, 18), value, { px: 13, weight: 500 });
          imp.addMorph(v); v.setPosition(lively.pt(170, y - 1));
        }
        line(36, "Platforms", (pl.platforms && pl.platforms.length) ? pl.platforms.join(", ") : "Not recorded");
        // playtime: a service's number wins and is read-only; otherwise the owner can type their own
        if (pl.playtime_minutes != null) {
          line(60, "Playtime", pl.playtime_minutes + " min · " + (pl.playtime_source === "itch" ? "itch.io" : "Steam"));
        } else if (owner) {
          line(60, "Your own playtime (hours)", null);
          d.hours = ui.input(lively.rect(0, 0, 84, 28), { value: hoursText(pl.manual_playtime_minutes), px: 13, maxLen: 8, onInput: later, onEnter: flush });
          imp.addMorph(d.hours.box); d.hours.box.setPosition(lively.pt(170, 54));
          var by = ui.label(lively.rect(0, 0, 80, 18), "by you", { px: 12, color: th.muted }); imp.addMorph(by); by.setPosition(lively.pt(262, 60));
        } else {
          line(60, "Playtime", pl.manual_playtime_minutes != null ? hoursText(pl.manual_playtime_minutes) + " h · by them" : "Not shared");
        }
        line(86, "Last synced", pl.last_synced_at ? dateText(pl.last_synced_at) : "Never (added by hand)");
        var note = ui.label(lively.rect(0, 0, pw - 28, 28), "Read-only. These details came from " + (pl.cover_source === "igdb" || pl.igdb_id ? "the game database when you added the game." : "where the game was added from."), { px: 11, color: th.muted, wrap: true });
        imp.addMorph(note); note.setPosition(lively.pt(14, 106));

        // ── personal panel: accent border, editable (owner) or plain text (visitor).
        // Coordinates inside `take` (the status, rating and visibility controls are rebuilt by
        // renderTake; the review and hours fields are NOT, so typing is never interrupted).
        var ty = 230, tph = owner ? 336 : 200;
        var take = ui.box(lively.rect(238, ty, pw, tph), th.surface, { radius: 12, border: th.accent, borderWidth: 2 });
        p.addMorph(take);
        take.addMorph(ui.icon(lively.rect(12, 10, 20, 20), owner ? "edit" : "person", 16, th.accent));
        var tl = ui.label(lively.rect(0, 0, 200, 16), owner ? "YOUR TAKE" : "THEIR TAKE", { px: 11, bold: true, color: th.accentText });
        take.addMorph(tl); tl.setPosition(lively.pt(36, 12));
        d.rows = ui.box(lively.rect(0, 0, pw - 4, tph - 4), null, { clip: false });
        d.rows.eventsAreIgnored = false;
        take.addMorph(d.rows);

        function renderTake() {
          d.rows.submorphs.slice().forEach(function (c) { c.remove(); });
          var pl = P(), e = cur(), x = 14;
          var lab = function (y, t) { var l = ui.label(lively.rect(0, 0, 220, 16), t, { px: 12, color: th.muted }); d.rows.addMorph(l); l.setPosition(lively.pt(14, y)); };
          lab(36, "Status");
          lively.gaming.GameLog.STATUSES.forEach(function (s) {
            var sc = th.status[s], on = pl.status === s, lbl = ui.STATUS_LABEL[s], w = ui.textW(lbl, 12, 600) + 26;
            if (!owner) { if (on) d.rows.addMorph(ui.statusPill(14, 54, s)); return; }
            var b = clickBox(lively.rect(x, 54, w, 28), {
              fill: on ? sc.bg : null, radius: 14, border: on ? sc.fg : th.line, role: "radio", pressed: on, label: "Status: " + lbl,
              onClick: function () {
                if (on) return;
                setTimeout(function () { host.saveEntry(d.entry, { status: s, last_activity: activityFor(s) }); renderTake(); }, 0);
              },
            }, function (box) { box.addMorph(ui.label(lively.rect(0, 4, w, 20), lbl, { px: 12, weight: 600, align: "center", color: on ? sc.fg : th.muted })); });
            d.rows.addMorph(b); x += w + 8;
          });
          lab(90, "Rating");
          if (owner) {
            for (var i = 1; i <= 5; i++) (function (i) {
              var filled = i <= (pl.rating || 0);
              var s = clickBox(lively.rect(14 + (i - 1) * 32, 106, 30, 30), {
                radius: 8, role: "radio", pressed: pl.rating === i, label: i + (i === 1 ? " star" : " stars") + (pl.rating === i ? ". Click again to clear." : ""),
                onClick: function () {
                  var next = P().rating === i ? 0 : i;     // clicking the current rating clears it
                  setTimeout(function () { host.saveEntry(d.entry, { rating: next, last_activity: { kind: "rated", at: new Date().toISOString() } }); renderTake(); }, 0);
                },
              }, function (box) { box.addMorph(ui.label(lively.rect(0, 1, 30, 28), filled ? "★" : "☆", { px: 22, color: th.star, align: "center" })); });
              d.rows.addMorph(s);
            })(i);
          } else {
            var r = ui.label(lively.rect(0, 0, 160, 24), ui.starsText(pl.rating), { px: 18, color: th.star });
            d.rows.addMorph(r); r.setPosition(lively.pt(14, 106));
          }
          if (!owner) return;
          lab(244, "Who can see this");
          var vx = 14;
          VIS_OPTIONS.forEach(function (o) {
            var on = e.visibility === o.key, w = ui.textW(o.label, 12, 700) + 46;
            var b = clickBox(lively.rect(vx, 262, w, 28), {
              fill: on ? th.accentSoft : null, radius: 14, border: on ? th.accent : th.line, role: "radio", pressed: on, disabled: !o.enabled,
              label: "Visibility: " + o.label + (o.enabled ? "" : " (not available)"),
              onClick: function () {
                // Friends: ask who, in the audience dialog (also when already selected, to edit the
                // audience). The controls redraw once the choice has been applied on screen.
                if (o.key === "shared") { setTimeout(function () { host.chooseAudience(cur(), renderTake); }, 0); return; }
                if (on) return;
                setTimeout(function () {
                  host.saveEntry(d.entry, { visibility: o.key }, function (err) { if (!err) host.toast(ui.trunc(P().title, 30) + " is now " + o.label.toLowerCase()); });
                  renderTake();
                }, 0);
              },
            }, function (box) {
              box.addMorph(ui.icon(lively.rect(8, 4, 20, 20), o.icon, 14, o.enabled ? (on ? th.accent : th.muted) : th.line));
              box.addMorph(ui.label(lively.rect(28, 4, w - 28, 20), o.label, { px: 12, bold: true, color: o.enabled ? (on ? th.accentText : th.muted) : th.line }));
            });
            d.rows.addMorph(b); vx += w + 8;
          });
          // the plain truth about the choice that is selected
          var cur2 = VIS_OPTIONS.filter(function (o) { return o.key === e.visibility; })[0] || VIS_OPTIONS[0];
          var ex = ui.label(lively.rect(0, 0, pw - 32, 34), cur2.text, { px: 11, color: e.visibility === "public" ? th.danger : th.muted, wrap: true });
          d.rows.addMorph(ex); ex.setPosition(lively.pt(14, 296));
        }

        if (owner) {
          // review: typed; saved shortly after typing stops and when the dialog closes
          var rlab = ui.label(lively.rect(0, 0, 200, 16), "Review", { px: 12, color: th.muted }); p.addMorph(rlab); rlab.setPosition(lively.pt(252, ty + 142));
          d.review = ui.textArea(lively.rect(252, ty + 160, pw - 28, 72), { value: pl.review || "", placeholder: "Write a review, or a note to yourself", px: 13, onInput: later });
          p.addMorph(d.review.box);
        } else {
          var rv = ui.label(lively.rect(0, 0, pw - 28, 60), pl.review || "No review.", { px: 13, color: pl.review ? th.text : th.muted, wrap: true });
          p.addMorph(rv); rv.setPosition(lively.pt(252, ty + 142));
        }
        renderTake();

        // ── footer
        if (owner) {
          var foot = ui.box(lively.rect(0, 0, W, 56), null, { clip: false });
          foot.eventsAreIgnored = false;
          p.addMorph(foot); foot.setPosition(lively.pt(0, H - 62));
          var renderFoot = function () {
            foot.submorphs.slice().forEach(function (c) { c.remove(); });
            if (d.confirming) {
              var msg = ui.label(lively.rect(0, 0, 320, 20), "Remove this game from your library?", { px: 13, bold: true, color: th.danger });
              foot.addMorph(msg); msg.setPosition(lively.pt(24, 17));
              var no = ui.button(0, 12, "Cancel", { variant: "secondary", onClick: function () { d.confirming = false; setTimeout(renderFoot, 0); } });
              var yes = ui.button(0, 12, "Remove", { variant: "danger", onClick: function () {
                m.close();
                host.removeEntry(cur(), function (err) { if (!err) host.toast("Removed from your library"); });
              } });
              yes.setPosition(lively.pt(W - 24 - yes.getExtent().x, 12));
              no.setPosition(lively.pt(W - 24 - yes.getExtent().x - 8 - no.getExtent().x, 12));
              foot.addMorph(no); foot.addMorph(yes);
            } else {
              foot.addMorph(ui.button(24, 12, "Remove from library", { variant: "danger", icon: "delete", onClick: function () { d.confirming = true; setTimeout(renderFoot, 0); } }));
              var done = ui.button(0, 12, "Done", { variant: "primary", onClick: function () { m.close(); } });
              done.setPosition(lively.pt(W - 24 - done.getExtent().x, 12));
              foot.addMorph(done);
              // Opens the share dialog in place of this one (opening a dialog closes the current one;
              // typed fields are saved on close).
              var share = ui.button(0, 12, "Share as postcard", { variant: "secondary", icon: "mail", onClick: function () { setTimeout(function () { host.openShare(cur()); }, 0); } });
              share.setPosition(lively.pt(W - 24 - done.getExtent().x - 8 - share.getExtent().x, 12));
              foot.addMorph(share);
            }
          };
          renderFoot();
        } else {
          var done2 = ui.button(0, 0, "Done", { variant: "primary", onClick: function () { m.close(); } });
          p.addMorph(done2); done2.setPosition(lively.pt(W - 24 - done2.getExtent().x, H - 52));
        }
        return m;
      },

      // ─── add a game ────────────────────────────────────────────────────────

      openAdd: function (host) {
        var ui = UI(), th = ui.theme();
        var W = 580, H = 660;
        var a = { seq: 0, timer: null, games: [], configured: null, mode: "popular", query: "", message: "" };
        var m = ui.openModal({ host: host, w: W, h: H, label: "Add a game", onClose: function () { clearTimeout(a.timer); a.seq++; } });
        var p = m.panel;
        p.addMorph(ui.label(lively.rect(24, 22, W - 100, 28), "Add a game", { px: 20, font: "display" }));
        p.addMorph(closeButton(m, W - 52, 18));

        a.search = ui.input(lively.rect(24, 62, W - 48, 40), {
          placeholder: "Search for a game", px: 14, maxLen: 100,
          onInput: function (v) {
            a.query = v;
            clearTimeout(a.timer);
            a.timer = setTimeout(function () { a.query.trim() ? runSearch(a.query.trim()) : showPopular(); }, 350);
          },
        });
        p.addMorph(a.search.box);

        a.head = ui.label(lively.rect(24, 116, W - 48, 16), "", { px: 11, bold: true, color: th.muted });
        p.addMorph(a.head);
        var listH = H - 132 - 150;
        a.list = ui.box(lively.rect(24, 138, W - 48, listH), null, { clip: true });
        a.list.applyStyle({ clipMode: "auto" });
        a.list.eventsAreIgnored = false;
        p.addMorph(a.list);
        ui.scroller(a.list, th);

        // footer: add by title, always available (the search can be down or unconfigured)
        var fy = H - 140;
        p.addMorph(ui.box(lively.rect(0, fy, W, 1), th.line));
        var fl = ui.label(lively.rect(0, 0, W - 48, 18), "Not listed? Add it by its title", { px: 12, bold: true, color: th.muted }); p.addMorph(fl); fl.setPosition(lively.pt(24, fy + 14));
        var addTitle = function (v) {
          v = String(v || "").trim();
          if (!v) return;
          host.addGame({ title: v }, "private", function (err, entry) {
            if (err) return;
            host.toast("Added " + ui.trunc(v, 34) + " (private)");
            a.manual.setValue("");
            renderRows();
          });
        };
        a.manual = ui.input(lively.rect(24, fy + 40, W - 48 - 100, 40), { placeholder: "Title", px: 14, maxLen: 120, onEnter: addTitle });
        p.addMorph(a.manual.box);
        var addBtn = ui.button(W - 24 - 88, fy + 40, "Add", { variant: "primary", h: 40, w: 88, onClick: function () { addTitle(a.manual.getValue()); } });
        p.addMorph(addBtn);
        var attr = ui.label(lively.rect(0, 0, W - 48, 16), "Everything you add starts private. Game data from IGDB.", { px: 11, color: th.muted }); p.addMorph(attr); attr.setPosition(lively.pt(24, fy + 96));

        // is this game already in the library? (same database id, or the same title)
        function inLibrary(g) {
          var t = String(g.title).toLowerCase();
          return host.state.entries.some(function (e) { return (g.igdb_id && e.payload.igdb_id === g.igdb_id) || String(e.payload.title).toLowerCase() === t; });
        }
        function fieldsOf(g) {
          return { title: g.title, year: g.year, genre: g.genre, studio: g.studio, cover_url: g.cover_url, cover_source: g.cover_url ? "igdb" : null, igdb_id: g.igdb_id, platforms: g.platforms || [] };
        }

        // rows of results (or one message)
        function renderRows() {
          a.list.submorphs.slice().forEach(function (c) { c.remove(); });
          a.head.setTextString(a.headText || "");
          if (a.message) {
            var msg = ui.label(lively.rect(0, 0, W - 48 - 12, 60), a.message, { px: 13, color: th.muted, wrap: true });
            a.list.addMorph(msg); msg.setPosition(lively.pt(4, 8));
            return;
          }
          a.games.forEach(function (g, i) {
            var y = i * 72, have = inLibrary(g);
            var row = ui.box(lively.rect(0, y, W - 48 - 12, 64), null, { radius: 10, border: th.line });
            row.eventsAreIgnored = false;
            var cov = coverBox(lively.rect(8, 5, 40, 54), { title: g.title, cover_url: g.cover_url }, 6); row.addMorph(cov);
            var rowW = W - 48 - 12 - 60 - 110 - 10;
            var t = ui.label(lively.rect(0, 0, W - 48 - 12 - 60 - 110, 20), ui.fit(g.title, 14, 700, rowW), { px: 14, bold: true }); row.addMorph(t); t.setPosition(lively.pt(60, 10));
            var sub = [g.year, g.genre, g.studio].filter(Boolean).join(" · ");
            var s = ui.label(lively.rect(0, 0, W - 48 - 12 - 60 - 110, 18), ui.fit(sub, 12, 400, rowW), { px: 12, color: th.muted }); row.addMorph(s); s.setPosition(lively.pt(60, 34));
            var b = ui.button(W - 48 - 12 - 12 - 84, 16, have ? "In library" : "Add", {
              variant: have ? "secondary" : "primary", w: 84, h: 32, disabled: have, ariaLabel: (have ? "Already in your library: " : "Add ") + g.title,
              onClick: function () {
                host.addGame(fieldsOf(g), "private", function (err) {
                  if (err) return;
                  host.toast("Added " + ui.trunc(g.title, 30) + " (private)");
                  setTimeout(renderRows, 0);
                });
              },
            });
            row.addMorph(b);
            a.list.addMorph(row);
          });
          var sp = ui.box(lively.rect(0, a.games.length * 72, 4, 4), null); sp.eventsAreIgnored = true; a.list.addMorph(sp);
        }

        // Calls the proxy; maps its failures to plain messages. `thenDo(games)`.
        function ask(path, mySeq, headText) {
          a.message = ""; a.headText = headText; a.games = []; a.message = "Searching…"; renderRows();
          fetch(IGDB + path, { credentials: "include", headers: { Accept: "application/json" } })
            .then(function (res) { return res.json().catch(function () { return {}; }).then(function (b) { return { status: res.status, body: b }; }); })
            .then(function (r) {
              if (mySeq !== a.seq) return;                       // a newer search superseded this one
              if (r.status === 503) { a.configured = false; a.games = []; a.message = "Game search isn't set up on this server yet. You can still add a game by its title below."; }
              else if (r.status === 401) { a.games = []; a.message = "Sign in to search for games. You can still add one by its title below."; }
              else if (r.status !== 200) { a.games = []; a.message = "The game database didn't answer. Try again, or add the game by its title below."; }
              else { a.games = r.body.games || []; a.message = a.games.length ? "" : "No games found. Try another spelling, or add it by its title below."; }
              renderRows();
            })
            .catch(function () { if (mySeq === a.seq) { a.games = []; a.message = "Couldn't reach the server. Add the game by its title below."; renderRows(); } });
        }
        function showPopular() { ask("popular", ++a.seq, "POPULAR RIGHT NOW"); }
        function runSearch(q) { ask("search?q=" + encodeURIComponent(q), ++a.seq, "RESULTS FOR “" + ui.trunc(q, 30).toUpperCase() + "”"); }

        showPopular();
        a.search.focus();
        return m;
      },
    };
  }); // end module('lively.gaming.GameDialogs')
