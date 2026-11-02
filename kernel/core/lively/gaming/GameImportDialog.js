/**
 * lively.gaming.GameImportDialog
 *
 * The dialog that brings a linked account's games into the library: pick an account, read
 * its library, review what is new, confirm, watch the import run. Opened over the library
 * with GamingUI.openModal, from the Import button (Gaming.openImport).
 *
 *   open(host)    host is the lively.gaming.Gaming morph
 *
 * THE FIVE STAGES (d.stage), each drawn by its own function into one body box:
 *   loading   asking the server which accounts are linked
 *   ready     one card per linked account, saying what pressing "Read library" will do
 *   reading   waiting for the store's answer (the sync)
 *   preview   what was found: new games to tick or untick, the visibility, Import
 *   progress  "Importing 37 of 142", with Stop
 *   done      what happened
 * and `error`, which any stage can fall into, with a plain sentence and a way forward.
 *
 * WHAT IS NEVER DONE WITHOUT THE OWNER. Reading a library happens only when "Read library" is
 * pressed (some stores' terms allow reading a person's data only when they ask). Nothing is
 * written to the library until "Import N games" is pressed. Imported games start PRIVATE;
 * Public has to be chosen and is described as what it is.
 *
 * The logic (what is new, what to refresh, the write queue) lives in lively.gaming.GamingImport
 * and is unit-tested; the writes go through Gaming.importGames. This file only draws and wires.
 *
 * Re-render rule (the same as GameDialogs): a click handler never rebuilds the morph that
 * received the click while it is still handling it. Anything that changes on a click is
 * rebuilt one tick later (setTimeout 0).
 */

module("lively.gaming.GameImportDialog")
  .requires("lively.morphic.Complete", "lively.gaming.GamingUI", "lively.gaming.GamingImport", "lively.gaming.GameLinks", "lively.gaming.GameDialogs")
  .toRun(function () {

    var UI = function () { return lively.gaming.GamingUI; };
    var GI = function () { return lively.gaming.GamingImport; };
    var GD = function () { return lively.gaming.GameDialogs; };

    // Rows shown before "Show more", and the height one row takes (52 px of row plus a gap).
    var PAGE = 40, ROW_H = 58;

    // What each store's "Read library" button does, in words that stay true to what the server
    // does. (One store returns only a public game list, and nothing at all when the person's
    // game details are private; the other returns the games the person owns, with no playtime.)
    var DISCLOSURE = {
      steam: "We read your public game list and playtime from Steam, only now, because you pressed the button. Steam only returns games when “Game details” is public in your Steam privacy settings. Nothing is saved until you confirm the list. Not affiliated with or endorsed by Steam.",
      itch: "We read the games you own on itch.io, only now, because you pressed the button. itch.io does not provide playtime. Nothing is saved until you confirm the list.",
    };

    // The line under the summary in the preview: what to expect from that store.
    var PREVIEW_HINT = {
      steam: "Steam only returns games when “Game details” is public in your Steam privacy settings (Profile, Edit Profile, Privacy Settings). You can set it back afterwards.",
      itch: "itch.io does not provide playtime, so imported games start without any. You can type your own on each game.",
    };

    // "47 h", "35 min": the playtime a candidate carries, with its store, or the honest absence.
    function playtimeText(c) {
      var store = GI().platformLabel(c.platform);
      if (c.playtime_minutes == null) return "No playtime from " + store;
      if (c.playtime_minutes === 0) return "Not played yet · " + store;
      var m = c.playtime_minutes, t = m < 60 ? m + " min" : (Math.round(m / 6) / 10) + " h";
      return t + " · " + store;
    }

    // A plain sentence for a failed read, chosen from the stable code GameLinks gives. `action`
    // names what the button should do: "retry" or "connect" (open Settings on the Connected tab).
    function explain(err, platform) {
      var store = GI().platformLabel(platform);
      switch (err && err.code) {
        case "rate_limited": {
          var s = err.retryAfter, when = s == null ? "a minute" : s < 90 ? Math.max(1, Math.round(s)) + " seconds" : Math.ceil(s / 60) + " minutes";
          return { title: "Too soon", text: "You read " + store + " a moment ago. Try again in about " + when + ".", action: "retry" };
        }
        case "not_linked": return { title: store + " isn't linked", text: "There is no linked " + store + " account any more. Link it again in Settings.", action: "connect" };
        case "needs_reconnect": return { title: "Link " + store + " again", text: store + " no longer accepts the saved link (it may have been revoked). Link it again in Settings; nothing in your library changes.", action: "connect" };
        case "unavailable": return { title: "Not set up here", text: "This server isn't set up to read " + store + " libraries yet. You can still add games by hand.", action: null };
        case "signin": return { title: "Sign in first", text: "Sign in to import games.", action: null };
        case "network": return { title: "No connection", text: "Couldn't reach the server. Check your connection and try again.", action: "retry" };
        default: return { title: store + " didn't answer", text: "The store didn't give a usable answer. Try again in a minute.", action: "retry" };
      }
    }

    lively.gaming.GameImportDialog = {

      open: function (host) {
        var ui = UI(), th = ui.theme(), GD_ = GD();
        if (!host.isOwner()) return null;

        var d = {
          stage: "loading", accounts: [], platform: null,
          result: null, plan: null, selected: {}, shown: PAGE, visibility: "private",
          starting: false, cancelled: false, done: 0, total: 0, summary: null, error: null,
        };
        var m = ui.openModal({
          host: host, w: 640, h: 720, label: "Import games",
          // Closing mid-import is a Stop: writes already started settle, no new ones begin.
          onClose: function () { d.cancelled = true; },
        });
        var p = m.panel, ext = p.getExtent(), PW = ext.x, PH = ext.y;

        p.addMorph(ui.label(lively.rect(24, 22, PW - 100, 28), "Import games", { px: 20, font: "display" }));
        p.addMorph(GD_.closeButton(m, PW - 52, 18));
        d.body = ui.box(lively.rect(0, 60, PW, PH - 60), null, { clip: false });
        p.addMorph(d.body);
        var BW = PW, BH = PH - 60;

        // ── small shared pieces ──────────────────────────────────────────────

        function clear() { d.body.submorphs.slice().forEach(function (c) { c.remove(); }); }
        function later(fn) { setTimeout(function () { if (!m.closed) fn(); }, 0); }
        function go(stage) { d.stage = stage; later(render); }

        // A wrapped paragraph in the body. Height is 18 px a line plus padding: a guessed
        // per-line height clips the last line (CLAUDE.md).
        function para(y, text, o) {
          o = o || {};
          var lines = o.lines || Math.max(1, Math.ceil(ui.textW(text, o.px || 13) / (BW - 48 - 8)));
          var l = ui.label(lively.rect(0, 0, BW - 48, lines * 18 + 8), text, { px: o.px || 13, color: o.color || th.muted, wrap: true, bold: !!o.bold });
          d.body.addMorph(l); l.setPosition(lively.pt(24, y));
          return l;
        }

        function openSettings() {
          m.close();
          lively.require("lively.identity.SettingsDialog").toRun(function () { lively.identity.SettingsDialog.open("connected"); });
        }

        function primary(x, y, text, fn, o) {
          var b = ui.button(x, y, text, Object.assign({ variant: "primary", onClick: fn }, o || {}));
          d.body.addMorph(b); return b;
        }
        function secondary(x, y, text, fn, o) {
          var b = ui.button(x, y, text, Object.assign({ variant: "secondary", onClick: fn }, o || {}));
          d.body.addMorph(b); return b;
        }
        // A button whose right edge sits at `right`.
        function rightAligned(b, right, y) { b.setPosition(lively.pt(right - b.getExtent().x, y)); return b; }

        // ── stage: loading / error ───────────────────────────────────────────

        function drawLoading(text) {
          para(30, text || "Looking for your linked accounts…", { color: th.muted });
        }

        function drawError() {
          var e = d.error;
          var title = ui.label(lively.rect(0, 0, BW - 48, 26), e.title, { px: 16, bold: true, color: th.danger });
          d.body.addMorph(title); title.setPosition(lively.pt(24, 24));
          para(58, e.text, { color: th.text, lines: 3 });
          var y = 128, x = BW - 24;
          var close = rightAligned(secondary(0, y, "Close", function () { m.close(); }), x, y);
          x -= close.getExtent().x + 8;
          if (e.action === "retry") rightAligned(primary(0, y, "Try again", function () { later(e.retry || start); }), x, y);
          else if (e.action === "connect") rightAligned(primary(0, y, "Open Settings", function () { openSettings(); }), x, y);
        }

        // ── stage: ready (one card per linked account) ───────────────────────

        function drawReady() {
          if (!d.accounts.length) {
            para(24, "No account is linked yet.", { px: 16, bold: true, color: th.text, lines: 1 });
            para(54, "Link a game-store account in Settings to bring your games along. Nothing is read until you press “Read library”, and everything you import starts private. You can always add games by hand instead.", { lines: 4 });
            rightAligned(primary(0, 160, "Connect an account", function () { openSettings(); }), BW - 24, 160);
            return;
          }
          para(20, "Choose an account to read. Nothing is read until you press the button, and nothing is saved until you confirm the list.", { lines: 2 });
          var y = 74;
          d.accounts.forEach(function (a) {
            var store = GI().platformLabel(a.platform), ok = a.status === "active";
            var card = ui.box(lively.rect(24, y, BW - 48, 150), th.surface, { radius: 12, border: th.line });
            d.body.addMorph(card);
            card.addMorph(ui.icon(lively.rect(14, 14, 24, 24), "sync", 18, th.muted));
            var name = ui.label(lively.rect(0, 0, BW - 48 - 200, 22), store, { px: 15, bold: true }); card.addMorph(name); name.setPosition(lively.pt(44, 14));
            var sub = a.display_name || (a.external_id ? "Account " + a.external_id : "");
            var last = a.last_synced_at ? "Last read " + new Date(a.last_synced_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "Not read yet";
            var s2 = ui.label(lively.rect(0, 0, BW - 48 - 200, 18), ui.trunc((sub ? sub + " · " : "") + last, 60), { px: 12, color: th.muted }); card.addMorph(s2); s2.setPosition(lively.pt(44, 38));
            var note = ui.label(lively.rect(0, 0, BW - 48 - 28, 72), ok ? (DISCLOSURE[a.platform] || "") : store + " needs to be linked again before it can be read.", { px: 12, color: th.muted, wrap: true });
            card.addMorph(note); note.setPosition(lively.pt(14, 70));
            var btn = ok
              ? ui.button(0, 12, "Read library", { variant: "primary", onClick: function () { d.platform = a.platform; later(read); } })
              : ui.button(0, 12, "Link again", { variant: "secondary", onClick: function () { openSettings(); } });
            card.addMorph(btn); btn.setPosition(lively.pt(BW - 48 - 14 - btn.getExtent().x, 12));
            y += 162;
          });
        }

        // ── reading: the sync ────────────────────────────────────────────────

        function read() {
          d.stage = "reading"; render();
          var platform = d.platform;
          lively.gaming.GameLinks.sync(platform, function (err, result) {
            if (m.closed) return;
            if (err) {
              d.error = explain(err, platform);
              d.error.retry = function () { read(); };
              return go("error");
            }
            d.result = result;
            d.plan = GI().plan(result.candidates, host.state.entries, { syncedAt: result.fetched_at });
            // Everything new starts ticked: the owner unticks what they do not want.
            d.selected = {}; d.plan.fresh.forEach(function (c) { d.selected[c.external_id] = true; });
            d.shown = PAGE; d.visibility = "private"; d.starting = false;
            go("preview");
          });
        }

        // ── stage: preview ───────────────────────────────────────────────────

        function selCount() { return d.plan.fresh.filter(function (c) { return d.selected[c.external_id]; }).length; }

        // One row: the whole row is the toggle (a click anywhere on it). Its children are
        // decorative (events ignored) so the row owns the click (capture-first dispatch).
        function buildRow(c, y, w) {
          var on = !!d.selected[c.external_id];
          var row = GD_.clickBox(lively.rect(0, y, w, 52), {
            fill: on ? th.accentSoft : null, radius: 10, border: on ? th.accent : th.line,
            role: "button", pressed: on, label: (on ? "Will import: " : "Will not import: ") + c.name,
            onClick: function () {
              d.selected[c.external_id] = !d.selected[c.external_id];
              later(function () { replaceRow(c); renderFooter(); });
            },
          }, function (box) {
            var cb = ui.box(lively.rect(12, 15, 22, 22), on ? th.accent : null, { radius: 6, border: on ? th.accent : th.muted, borderWidth: 2 });
            cb.eventsAreIgnored = true;
            if (on) cb.addMorph(ui.icon(lively.rect(0, 1, 18, 18), "check", 14, th.onAccent));
            box.addMorph(cb);
            var cov = GD_.coverBox(lively.rect(44, 4, 36, 44), { title: c.name, cover_url: c.cover_url }, 5);
            cov.eventsAreIgnored = true; box.addMorph(cov);
            var pillX = w - 12 - 86;
            var t = ui.label(lively.rect(0, 0, pillX - 96, 20), ui.trunc(c.name, 48), { px: 13, bold: true }); box.addMorph(t); t.setPosition(lively.pt(92, 7));
            var s = ui.label(lively.rect(0, 0, pillX - 96, 18), playtimeText(c), { px: 12, color: th.muted }); box.addMorph(s); s.setPosition(lively.pt(92, 28));
            var st = GI().suggestStatus(c, Date.now());
            var pill = ui.statusPill(w - 12 - 90, 16, st); pill.eventsAreIgnored = true; box.addMorph(pill);
          });
          return row;
        }

        function replaceRow(c) {
          var r = d.rows && d.rows[c.external_id];
          if (!r) return;
          r.morph.remove();
          r.morph = buildRow(c, r.y, r.w);
          d.list.addMorph(r.morph);
        }

        // (Re)builds every shown row. Used on entering the preview and on "Show more".
        function renderList() {
          d.list.submorphs.slice().forEach(function (c) { c.remove(); });
          d.rows = {};
          var fresh = d.plan.fresh, n = Math.min(d.shown, fresh.length), w = d.list.getExtent().x - 14;
          for (var i = 0; i < n; i++) {
            var c = fresh[i], y = i * ROW_H;
            var row = buildRow(c, y, w);
            d.rows[c.external_id] = { morph: row, y: y, w: w };
            d.list.addMorph(row);
          }
          var y2 = n * ROW_H;
          if (n < fresh.length) {
            var more = fresh.length - n;
            var b = ui.button(0, y2 + 4, "Show " + Math.min(PAGE, more) + " more (" + more + " left)", { variant: "secondary", onClick: function () { d.shown += PAGE; later(renderList); } });
            d.list.addMorph(b); b.setPosition(lively.pt(Math.round((w - b.getExtent().x) / 2), y2 + 4));
            y2 += 44;
          }
          var sp = ui.box(lively.rect(0, y2, 4, 4), null); sp.eventsAreIgnored = true; d.list.addMorph(sp);
        }

        // The select-all link, the visibility choice and the buttons. Rebuilt when a row is
        // toggled (the count changes) and when the visibility changes.
        function renderFooter() {
          if (!d.foot) return;
          d.foot.submorphs.slice().forEach(function (c) { c.remove(); });
          var plan = d.plan, n = selCount(), fw = d.foot.getExtent().x;

          var vl = ui.label(lively.rect(0, 0, 300, 18), "Imported games will be", { px: 12, bold: true, color: th.muted }); d.foot.addMorph(vl); vl.setPosition(lively.pt(24, 0));
          var vx = 24;
          [{ key: "private", icon: "lock", label: "Private", on: true }, { key: "public", icon: "public", label: "Public", on: true }].forEach(function (o) {
            var sel = d.visibility === o.key, w = ui.textW(o.label, 12, 700) + 46;
            var b = GD_.clickBox(lively.rect(vx, 24, w, 28), {
              fill: sel ? th.accentSoft : null, radius: 14, border: sel ? th.accent : th.line, role: "radio", pressed: sel, label: "Visibility: " + o.label,
              onClick: function () { if (d.visibility === o.key) return; d.visibility = o.key; later(renderFooter); },
            }, function (box) {
              box.addMorph(ui.icon(lively.rect(8, 4, 20, 20), o.icon, 14, sel ? th.accent : th.muted));
              box.addMorph(ui.label(lively.rect(28, 4, w - 28, 20), o.label, { px: 12, bold: true, color: sel ? th.accentText : th.muted }));
            });
            d.foot.addMorph(b); vx += w + 8;
          });
          var vt = d.visibility === "public"
            ? "Anyone can read these games. NOT encrypted: titles and playtime become public. You can change any game later."
            : "Only you. Encrypted: nobody else, and not even this server, can read them. You can change any game later.";
          var vtl = ui.label(lively.rect(0, 0, fw - 48, 38), vt, { px: 11, color: d.visibility === "public" ? th.danger : th.muted, wrap: true });
          d.foot.addMorph(vtl); vtl.setPosition(lively.pt(24, 58));
          if (plan.refresh.length) {
            var rn = ui.label(lively.rect(0, 0, fw - 48, 22), "Also refreshes the playtime of " + plan.refresh.length + (plan.refresh.length === 1 ? " game" : " games") + " already in your library.", { px: 11, color: th.muted });
            d.foot.addMorph(rn); rn.setPosition(lively.pt(24, 98));
          }

          var by = 126, canGo = n > 0 || plan.refresh.length > 0;
          var label = n > 0 ? "Import " + n + (n === 1 ? " game" : " games") : (plan.refresh.length ? "Refresh playtime" : "Nothing to import");
          var go_ = ui.button(0, by, label, { variant: "primary", disabled: !canGo, onClick: function () { later(startImport); } });
          d.foot.addMorph(go_); go_.setPosition(lively.pt(fw - 24 - go_.getExtent().x, by));
          var cancel = ui.button(0, by, "Cancel", { variant: "secondary", onClick: function () { m.close(); } });
          d.foot.addMorph(cancel); cancel.setPosition(lively.pt(fw - 24 - go_.getExtent().x - 8 - cancel.getExtent().x, by));

          // select all / none (only when there is something to choose)
          if (plan.fresh.length) {
            var all = n < plan.fresh.length;
            var link = ui.button(0, by, all ? "Select all" : "Select none", { variant: "ghost", onClick: function () {
              plan.fresh.forEach(function (c) { d.selected[c.external_id] = all; });
              later(function () { renderList(); renderFooter(); });
            } });
            d.foot.addMorph(link); link.setPosition(lively.pt(24, by));
          }
        }

        function drawPreview() {
          var plan = d.plan, res = d.result, store = GI().platformLabel(d.platform);
          var found = plan.fresh.length + plan.refresh.length + plan.unchanged;
          var line = found === 0
            ? "No games found on " + store
            : "Found " + found + (found === 1 ? " game" : " games") + " · " + plan.fresh.length + " new · " + (found - plan.fresh.length) + " already in your library";
          var s = ui.label(lively.rect(0, 0, BW - 48, 24), line, { px: 15, bold: true }); d.body.addMorph(s); s.setPosition(lively.pt(24, 16));

          var y = 44;
          // What to tell the owner under the summary: a warning from the server (in the danger
          // colour), the store's privacy hint when nothing at all came back, or, otherwise, the
          // store's plain "what to expect" line.
          var notes = [];
          if (res.warnings.length) notes.push(res.warnings.join(" "));
          else if (res.partial) notes.push("Only part of your library could be read.");
          if (found === 0 && d.platform === "steam") notes.push(PREVIEW_HINT.steam);
          var alarming = notes.length > 0;
          if (!alarming && PREVIEW_HINT[d.platform]) notes.push(PREVIEW_HINT[d.platform]);
          if (notes.length) { var wl = para(y, notes.join(" "), { px: 12, color: alarming ? th.danger : th.muted }); y += wl.getExtent().y + 2; }
          if (plan.skipped) { var sk = para(y, plan.skipped + (plan.skipped === 1 ? " entry" : " entries") + " could not be read and " + (plan.skipped === 1 ? "was" : "were") + " left out.", { px: 12 }); y += sk.getExtent().y; }

          if (!plan.fresh.length && !plan.refresh.length) {
            para(y + 10, found ? "Everything on " + store + " is already in your library." : "There is nothing to import.", { color: th.text, px: 13 });
            rightAligned(primary(0, BH - 56, "Done", function () { m.close(); }), BW - 24, BH - 56);
            return;
          }

          var footH = plan.refresh.length ? 176 : 156;
          if (plan.fresh.length) {
            var hd = ui.label(lively.rect(0, 0, 300, 16), "NEW GAMES", { px: 11, bold: true, color: th.muted }); d.body.addMorph(hd); hd.setPosition(lively.pt(24, y + 6));
            y += 28;
          }
          var listH = Math.max(80, BH - y - footH);
          d.list = ui.box(lively.rect(24, y, BW - 48, listH), null, { clip: true });
          d.list.applyStyle({ clipMode: "auto" });
          d.body.addMorph(d.list);
          ui.scroller(d.list, th);
          d.foot = ui.box(lively.rect(0, BH - footH, BW, footH), null, { clip: false });
          d.body.addMorph(d.foot);
          // the line above the footer
          d.body.addMorph(ui.box(lively.rect(0, BH - footH - 6, BW, 1), th.line));
          if (plan.fresh.length) renderList();
          renderFooter();
        }

        // ── stage: progress ──────────────────────────────────────────────────

        function startImport() {
          // A double click, or a second dialog, must not start a second run. importGames refuses
          // too, but stopping it here keeps the screen honest.
          if (d.starting || host.isImporting()) return;
          d.starting = true;
          var chosen = d.plan.fresh.filter(function (c) { return d.selected[c.external_id]; });
          d.total = chosen.length + d.plan.refresh.length; d.done = 0; d.cancelled = false;
          d.stage = "progress"; render();
          host.importGames(d.platform, d.plan, {
            selected: chosen, visibility: d.visibility, syncedAt: d.result.fetched_at,
            onProgress: function (n, t) { d.done = n; d.total = t; if (!m.closed) updateProgress(); },
            isCancelled: function () { return d.cancelled; },
          }, function (err, summary) {
            d.summary = err ? { error: err, created: 0, refreshed: 0, skipped: 0, failed: [], cancelled: false } : summary;
            if (m.closed) { host.toast(summaryLine(d.summary)); return; }   // the owner closed the dialog mid-run
            go("done");
          });
        }

        function updateProgress() {
          if (!d.progLabel) return;
          var pct = d.total ? Math.min(1, d.done / d.total) : 1;
          d.progLabel.setTextString(d.cancelled ? "Stopping… " + d.done + " of " + d.total : "Importing " + d.done + " of " + d.total);
          var w = Math.round(d.trackW * pct);
          d.progFill.setExtent(lively.pt(Math.max(w, 0), 10));
          var n = d.progFill.renderContext().shapeNode; if (n) n.style.width = w + "px";   // the model call alone has not always reached the DOM
        }

        function drawProgress() {
          d.progLabel = ui.label(lively.rect(0, 0, BW - 48, 24), "Importing 0 of " + d.total, { px: 15, bold: true });
          d.body.addMorph(d.progLabel); d.progLabel.setPosition(lively.pt(24, 28));
          d.trackW = BW - 48;
          var track = ui.box(lively.rect(24, 64, d.trackW, 10), th.surface2, { radius: 5 }); d.body.addMorph(track);
          d.progFill = ui.box(lively.rect(24, 64, 0, 10), th.accent, { radius: 5 }); d.body.addMorph(d.progFill);
          para(90, "Each game is encrypted and signed on this device before it is stored, which takes a moment per game. You can stop at any time: games already imported stay.", { px: 12, lines: 3 });
          rightAligned(secondary(0, 160, "Stop", function () { d.cancelled = true; later(updateProgress); }), BW - 24, 160);
          updateProgress();
        }

        // ── stage: done ──────────────────────────────────────────────────────

        function summaryLine(s) {
          if (s.error) return "The import could not start: " + s.error.message;
          var parts = [];
          if (s.created) parts.push("Imported " + s.created + (s.created === 1 ? " game" : " games"));
          if (s.refreshed) parts.push("refreshed " + s.refreshed);
          if (!parts.length) parts.push(s.cancelled ? "Stopped before anything was imported" : "Nothing needed importing");
          var t = parts.join(", ");
          if (s.failed && s.failed.length) t += ". " + s.failed.length + " could not be saved";
          return t;
        }

        function drawDone() {
          var s = d.summary;
          var head = ui.label(lively.rect(0, 0, BW - 48, 26), s.error ? "The import didn't start" : (s.cancelled ? "Stopped" : "Done"), { px: 16, bold: true, color: s.error || (s.failed && s.failed.length) ? th.danger : th.text });
          d.body.addMorph(head); head.setPosition(lively.pt(24, 24));
          para(58, summaryLine(s) + ".", { color: th.text, lines: 2 });
          var y = 100;
          if (s.failed && s.failed.length) { para(y, "The ones that failed were left out. Open Import again to retry them: games already imported are recognised and not added twice.", { px: 12, lines: 2 }); y += 48; }
          if (s.skipped) { para(y, s.skipped + (s.skipped === 1 ? " game was" : " games were") + " already present or being edited, and left as they were.", { px: 12, lines: 2 }); y += 48; }
          if (d.visibility === "private" && s.created) { para(y, "They are all private. Open a game to change who can see it.", { px: 12, lines: 1 }); y += 28; }
          rightAligned(primary(0, Math.max(y + 12, 150), "Done", function () { m.close(); }), BW - 24, Math.max(y + 12, 150));
          if (s.created || s.refreshed) host.toast(summaryLine(s));
        }

        // ── drawing and starting ─────────────────────────────────────────────

        function render() {
          clear();
          d.list = d.foot = d.progLabel = d.progFill = null;
          if (d.stage === "loading") drawLoading();
          else if (d.stage === "reading") drawLoading("Reading your " + GI().platformLabel(d.platform) + " library… this can take a few seconds.");
          else if (d.stage === "ready") drawReady();
          else if (d.stage === "preview") drawPreview();
          else if (d.stage === "progress") drawProgress();
          else if (d.stage === "done") drawDone();
          else if (d.stage === "error") drawError();
        }

        // Asks the server which accounts are linked. A single linked, healthy account still
        // gets the "ready" card: the explanation and the button are the consent, not a formality.
        function start() {
          d.stage = "loading"; render();
          lively.gaming.GameLinks.status(function (err, status) {
            if (m.closed) return;
            if (err) {
              d.error = err.code === "signin" ? explain(err, "steam")
                : { title: "Couldn't check your accounts", text: "The server didn't answer. Try again in a moment.", action: "retry" };
              d.error.retry = start;
              return go("error");
            }
            d.accounts = (status.accounts || []).filter(function (a) { return a.platform === "steam" || a.platform === "itch"; });
            go("ready");
          });
        }

        start();
        return m;
      },
    };
  }); // end module('lively.gaming.GameImportDialog')
