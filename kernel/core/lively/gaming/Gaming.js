/**
 * lively.gaming.Gaming
 *
 * The root of the Gaming world template: a game library you fill by hand, rate and
 * review, and choose per game who can see. This morph is a thin full-viewport Box. It
 * owns the library's DATA (state.entries) and every WRITE to it, and hands the drawing
 * to lively.gaming.LibraryView (the screen) and lively.gaming.GameDialogs (the add,
 * detail and visibility dialogs). Entries are stored by lively.gaming.GameLog, one
 * signed envelope per game, sealed to their owner unless made public.
 *
 * THE LIBRARY IS ACCOUNT DATA, NOT WORLD DATA. The world only remembers that it IS a
 * Gaming world; the games live in the owner's account, so several Gaming worlds show
 * the same library and a world saved with 3,000 games is still tiny.
 *
 * SAVING AND LOADING THE WORLD. The tree of tiles and dialogs must never be written into
 * the saved world: it is large, it is derived from the account's data, and a loaded
 * world rebuilds it anyway. So `submorphs` is in doNotSerialize (the saved root is a
 * few hundred bytes), and a restored root has NO `submorphs` property at all (not an
 * empty array), which is why onrestore sets it before anything else runs. The screen is
 * then rebuilt by _setup(), which runs whenever the morph gets a render context. Checked
 * with a real save and reload (tests/e2e/gaming-template.spec.js).
 *
 * Entry points:
 *   lively.gaming.Gaming.open(optPos)    open the template in the current world
 */

module("lively.gaming.Gaming")
  .requires("lively.morphic.Complete", "lively.gaming.GamingUI", "lively.gaming.GameLog", "lively.gaming.GamingImport", "lively.gaming.LibraryView")
  .toRun(function () {

    var GameLog = function () { return lively.gaming.GameLog; };

    lively.morphic.Box.subclass("lively.gaming.Gaming",

      "serialization",
      {
        // submorphs: see the header. The rest is runtime-only state: the loaded entries, the
        // screen controller, listeners and timers.
        doNotSerialize: ["submorphs", "state", "_view", "_unsubTheme", "_identityConnection", "_saveQueues", "_loadSeq", "_resizeTimer"],

        // A restored morph has no `submorphs` property (it was not serialized). Nothing may
        // touch it before it is an array again.
        onrestore: function ($super) {
          this.submorphs = [];
          $super();
        },
      },

      "initialization",
      {
        initialize: function ($super, optExtent) {
          $super(optExtent || lively.rect(0, 0, 1280, 820));
          // NOTE: $super already created the render context, and with it ran _setup() through
          // prepareForNewRenderContext. Anything done here AFTER $super (a setFill(null), say)
          // overwrites what _setup painted, which is why the page background is set again by
          // _paintBackground at the end of every build and layout.
          this.setBorderWidth(0);
          // A plain Box is draggable, droppable and grabbable; this one is the whole page.
          this.disableDragging();
          this.disableDropping();
          this.disableGrabbing();
          this._paintBackground();
        },

        // Runs for a fresh morph and for a restored one, whenever it is given a render context.
        prepareForNewRenderContext: function ($super, renderCtx) {
          if (!this.submorphs) this.submorphs = [];
          $super(renderCtx);
          this._setup();
        },

        // (Re)creates all runtime state and the screen. Safe to run more than once.
        _setup: function () {
          this._teardown();
          var UI = lively.gaming.GamingUI, self = this;
          UI.ensureFonts();
          // Widths are measured with the web fonts; if they are not in yet, redraw once when they are.
          if (!UI.fontsReady()) UI.onFontsReady(function () { if (self._view && !UI._modal) self.rebuild(); });
          this.state = { entries: [], hidden: 0, loaded: false, loading: false, error: null, ownerHandle: null };
          this._saveQueues = {};
          this._loadSeq = 0;
          this._unsubTheme = UI.onThemeChange(function () { self.rebuild(); });
          this._fitToWorld();
          this._build();
          this._bindIdentity();
          this._load();
        },

        // Drops listeners, timers and the screen controller. Every exit path (a rebuild, a
        // new render context, removal) goes through here so nothing is left running.
        _teardown: function () {
          if (this._unsubTheme) { this._unsubTheme(); this._unsubTheme = null; }
          this._unbindIdentity();
          if (this._view) { this._view.dispose(); this._view = null; }
          clearTimeout(this._resizeTimer);
          lively.gaming.GamingUI.closeModal();
          lively.gaming.GamingUI.dismissSharePrompt();
        },

        remove: function ($super) {
          this._teardown();
          $super();
        },
      },

      "screen",
      {
        // Empties the template and draws it again from the current theme. A theme switch calls
        // this instead of recolouring morphs in place (see GamingUI's header for why).
        rebuild: function () {
          lively.gaming.GamingUI.closeModal();
          this._build();
          if (this._view) this._view.refresh();
        },

        _build: function () {
          var UI = lively.gaming.GamingUI, th = UI.theme();
          (this.submorphs || []).slice().forEach(function (m) { m.remove(); });
          if (this._view) this._view.dispose();
          this._paintBackground();
          this._view = new lively.gaming.LibraryView(this);
          this._view.build();
          this._layout();
        },

        // The page colour, from the current theme. Written to the model AND the real node:
        // applyStyle / setFill on an already-rendered morph can update the model while the DOM
        // keeps the old paint (CLAUDE.md), and the colour may also be reset by a later render.
        // Idempotent, so it is called after every build and every layout.
        _paintBackground: function () {
          var th = lively.gaming.GamingUI.theme();
          this.setFill(th.bg);
          var node = this.renderContext() && this.renderContext().shapeNode;
          if (node) node.style.background = th.bg.toString();
        },

        _layout: function () {
          this._paintBackground();
          var e = this.getExtent();
          if (this._view) this._view.layout(e.x, e.y);
        },

        // Fills the visible part of the world (the same idiom the other full-page templates use:
        // MenuBar / MobileInterface). Called after the morph has an owner, and on world resize.
        _fitToWorld: function () {
          if (typeof $world === "undefined" || !$world) return;
          var vb = $world.visibleBounds();
          // The world's menu bar floats over the top 42px (10px margin + 32px bar): start below it.
          var top = lively.gaming.Gaming.MENU_BAR_INSET;
          this.setPosition(vb.topLeft().addXY(0, top));
          this.setExtent(vb.extent().addXY(0, -top));
        },

        onWorldResize: function () {
          var self = this;
          clearTimeout(this._resizeTimer);
          this._resizeTimer = setTimeout(function () { self._fitToWorld(); self._layout(); }, 150);
        },

        // The name shown in the header: the world's own name, or a default. $world.name is NOT kept
        // in sync with the assigned name; document.title is (the server sets it from the world's
        // record), so read that (CLAUDE.md, same as Books and Gallery).
        worldName: function () {
          var t = document.title;
          var generic = !t || t === "world" || t === "Lively" || t === "untitled world" || t === "blank";
          return generic ? "My Games" : t;
        },
      },

      "identity and data",
      {
        _currentUser: function () {
          if (typeof lively === "undefined" || !lively.identity || !lively.identity.did) return null;
          return lively.identity.did.currentUser();
        },

        // Whose library this is: the handle in the world's own URL (/@handle/<world>), or, on a
        // page with no such URL, whoever is signed in. null when neither is known.
        ownerHandle: function () {
          try {
            var parsed = lively.identity.webKey.parseObjectUrl(window.location.href);
            if (parsed && parsed.handle) return parsed.handle;
          } catch (e) { /* not an object URL */ }
          var u = this._currentUser();
          return u ? u.handle : null;
        },

        // Can the person looking at this edit it? Only the account whose library it is.
        isOwner: function () {
          var u = this._currentUser(), h = this.ownerHandle();
          return !!(u && h && u.handle === h);
        },

        _bindIdentity: function () {
          if (typeof lively === "undefined" || !lively.bindings || !lively.identity || !lively.identity.did) return;
          var self = this;
          this._identityConnection = lively.bindings.connect(lively.identity.did, "identityChanged", self, "_onIdentityChanged");
          if (lively.identity.did.restoreSession) lively.identity.did.restoreSession(function () { self._onIdentityChanged(); });
        },

        _unbindIdentity: function () {
          if (this._identityConnection && this._identityConnection.disconnect) this._identityConnection.disconnect();
          this._identityConnection = null;
        },

        // Sign-in state changed (the session restored, the person signed in or out). The owner
        // may have changed, so the library is read again.
        _onIdentityChanged: function () {
          if (!this.state) return;
          var h = this.ownerHandle();
          if (!this.state.loaded || h !== this.state.ownerHandle || this.isOwner() !== this._wasOwner) this._load();
        },

        reload: function () { this._load(); },

        // Reads the whole library, page by page. Entries appear as pages arrive. A later call
        // supersedes an earlier one still in flight (a stale answer must not overwrite it).
        _load: function () {
          var self = this, st = this.state, seq = ++this._loadSeq;
          var handle = this.ownerHandle();
          st.ownerHandle = handle;
          this._wasOwner = this.isOwner();
          st.error = null;
          if (!handle) { st.error = "signin"; st.loaded = true; st.entries = []; if (this._view) this._view.refresh(); return; }
          st.loading = true;
          st.loaded = false;
          if (this._view) this._view.refresh();
          GameLog().list(handle, {
            onPage: function (entries) { if (seq === self._loadSeq) { st.entries = entries; st.loaded = true; if (self._view) self._view.refresh(); } },
          }, function (err, result) {
            if (seq !== self._loadSeq) return;
            st.loading = false;
            if (err) { st.error = err.message || String(err); st.loaded = true; }
            else { st.entries = result.entries; st.hidden = result.hidden; st.loaded = true; }
            if (self._view) self._view.refresh();
            if (!err) self._syncSharing();
          });
        },

        // Brings the people each shared game is sealed to in line with the owner's friends,
        // orbit and lists as they are now (someone added to a list gets the games shared with
        // that list; someone who stopped being a friend loses them). Runs once per opened
        // library, only for the owner, and QUIETLY: if the account key is not already unlocked
        // it does nothing rather than raise a passkey prompt nobody asked for; the next
        // explicit save or the homestar's own sync does it instead. Failures are logged, not shown.
        _syncSharing: function () {
          var st = this.state;
          if (!st || st.sharingSynced || !this.isOwner()) return;
          if (!st.entries.some(function (e) { return e.visibility === "shared"; })) return;
          st.sharingSynced = true;
          lively.identity.postcardAudience.syncAudiences({ onlyIfKekCached: true }, function (err) {
            if (err) console.warn("[Gaming] audience sync failed:", err.message || err);
          });
        },

        // ─── writes (owner only; every one goes through GameLog) ─────────────

        // Adds a game. `fields` are payload fields (title required); `visibility` defaults to
        // private. Calls thenDo(err, entry). A game is never added Public by default: imports
        // and hand-added games both start private.
        addGame: function (fields, visibility, thenDo) {
          var self = this;
          if (!this.isOwner()) return thenDo && thenDo(new Error("Only the owner can add games"));
          GameLog().create(fields, visibility || "private", function (err, entry) {
            if (err) { self.toast("Couldn't add the game: " + err.message); return thenDo && thenDo(err); }
            self.state.entries.unshift(entry);
            if (self._view) self._view.refresh();
            if (thenDo) thenDo(null, entry);
          });
        },

        // Saves `changes` to an entry (payload fields, and/or { visibility }). Saves for the
        // SAME game are queued: each new version chains on the previous one's cid, so two
        // overlapping saves would fork the history and the second would be refused. Changes made
        // while a save is running are merged and sent as one follow-up save. Calls
        // thenDo(err, entry) when this call's changes have been stored.
        saveEntry: function (entry, changes, thenDo) {
          var self = this, q = this._saveQueues[entry.objId] || (this._saveQueues[entry.objId] = { running: false, pending: null, waiters: [] });
          // The status as it is on screen BEFORE this change, to tell a real change from a repeat.
          var shown = this.entryById(entry.objId), wasStatus = shown && shown.payload.status;
          q.pending = Object.assign(q.pending || {}, changes);
          q.waiters.push(thenDo || function () {});
          // The screen shows the change at once; the stored entry catches up when the save lands.
          this._applyLocal(entry.objId, changes);
          // Moving a game to Playing or Completed offers to tell friends (never on any other
          // status, never when the status did not actually change, never for an import).
          if (changes.status && changes.status !== wasStatus && (changes.status === "playing" || changes.status === "completed")) {
            this.offerShare(entry.objId, changes.status);
          }
          if (q.running) return;
          (function run(current) {
            var batch = q.pending, waiters = q.waiters;
            q.pending = null; q.waiters = []; q.running = true;
            GameLog().save(current, batch, function (err, saved) {
              q.running = false;
              if (err) {
                self.toast("Couldn't save: " + err.message);
                waiters.forEach(function (w) { w(err); });
                // the stored copy is the truth again: put it back on screen
                self._load();
                return;
              }
              self._replaceEntry(saved);
              waiters.forEach(function (w) { w(null, saved); });
              if (q.pending) { q.running = true; run(saved); }
            });
          })(this.entryById(entry.objId) || entry);
        },

        // Soft-deletes a game. Calls thenDo(err).
        removeEntry: function (entry, thenDo) {
          var self = this;
          GameLog().remove(this.entryById(entry.objId) || entry, function (err) {
            if (err) { self.toast("Couldn't remove it: " + err.message); return thenDo && thenDo(err); }
            self.state.entries = self.state.entries.filter(function (e) { return e.objId !== entry.objId; });
            if (self._view) self._view.refresh();
            if (thenDo) thenDo(null);
          });
        },

        entryById: function (objId) {
          return this.state.entries.filter(function (e) { return e.objId === objId; })[0] || null;
        },

        // Optimistic local update: shows a change before the server has confirmed it.
        _applyLocal: function (objId, changes) {
          var e = this.entryById(objId);
          if (!e) return;
          var c = Object.assign({}, changes);
          if (c.visibility) { e.visibility = c.visibility; delete c.visibility; }
          if (c.audience) { e.audience = c.audience; delete c.audience; }
          e.payload = Object.assign({}, e.payload, c);
          if (this._view) this._view.entryChanged(e);
        },

        // Swaps in the entry as the server stored it (new envelope, so the next save chains on it).
        // The payload shown on screen is kept if newer local changes are still queued.
        _replaceEntry: function (saved) {
          var list = this.state.entries;
          for (var i = 0; i < list.length; i++) {
            if (list[i].objId === saved.objId) {
              var q = this._saveQueues[saved.objId];
              var local = list[i];
              list[i] = (q && q.pending)
                ? { objId: saved.objId, did: saved.did, visibility: local.visibility, audience: local.audience, envelope: saved.envelope, payload: local.payload }
                : saved;
              break;
            }
          }
          if (this._view) this._view.entryChanged(saved);
        },

        toast: function (text) { lively.gaming.GamingUI.toast(text, null, this); },
      },

      "sharing",
      {
        // Offers, in a small card that fades away by itself, to share a game whose status just
        // became Playing or Completed as a postcard. Pressing "Share as postcard" opens the
        // share dialog for that game; "Not now" and the timeout do nothing at all.
        offerShare: function (objId, status) {
          var self = this, UI = lively.gaming.GamingUI, e = this.entryById(objId);
          if (!e || !this.isOwner()) return;
          var verb = status === "completed" ? "finished" : "started";
          UI.sharePrompt(this, {
            text: "You " + verb + " " + UI.trunc(e.payload.title, 30) + ". Tell your friends?",
            onShare: function () { var cur = self.entryById(objId); if (cur) self.openShare(cur); },
          });
        },

        // The "Share as postcard" dialog (lives in GameDialogs): what goes on the card, then the
        // postcard editor opens with it filled in.
        openShare: function (entry) {
          var self = this;
          lively.gaming.GamingUI.dismissSharePrompt();     // the dialog answers the offer
          this._dialogs(function (D) { D.openShare(self, entry); });
        },

        // Asks the owner who can see one game, in the same audience dialog the postcards use
        // (Public, Friends, Orbit, each list, specific people), then saves the answer. Used by
        // both the detail dialog and the visibility dialog, so the choice looks and behaves the
        // same wherever it is made. `thenDo()` runs right after the choice is applied on screen
        // (the save itself finishes a moment later), or when the dialog is cancelled, so a
        // caller can redraw its own controls. Owner only.
        chooseAudience: function (entry, thenDo) {
          var self = this, UI = lively.gaming.GamingUI;
          function end() { if (thenDo) thenDo(); }
          if (!this.isOwner()) return end();
          lively.require("lively.identity.AudienceDialog").toRun(function () {
            // Read fresh: the friends and lists may have changed since the library was opened.
            GameLog().loadContext(function (err, ctx) {
              if (err) { self.toast("Couldn't load your friends: " + (err.message || err)); return end(); }
              var cur = self.entryById(entry.objId) || entry;
              // While this dialog is up, Esc belongs to it: the template's own dialogs must not also close.
              UI._overlay = true;
              lively.identity.AudienceDialog.open({
                ctx: ctx,
                audience: ctx.cardAudiences[cur.objId] || cur.audience || null,
                isPublic: cur.visibility === "public",
                allowPublic: true,
                subtitle: cur.payload.title,
                noun: "game",
                helpPlace: "this library",
                onCancel: function () { UI._overlay = false; end(); },
                onSave: function (result) { UI._overlay = false; self.applyAudience(cur, result, ctx); end(); },
              });
            });
          });
        },

        // Saves the audience dialog's answer: { pub, audience: { tiers, people } }. Public
        // publishes the game in the clear; an audience naming nobody makes it private; anything
        // else seals it to exactly those people. Says what happened, including when some people
        // could not be sealed to.
        applyAudience: function (entry, result, ctx) {
          var self = this, R = lively.identity.AudienceRules, title = lively.gaming.GamingUI.trunc(entry.payload.title, 30);
          var aud = result.audience, changes, note;
          if (result.pub) { changes = { visibility: "public" }; note = title + " is now public"; }
          else if (!aud.tiers.length && !aud.people.length) { changes = { visibility: "private" }; note = title + " is now private"; }
          else {
            changes = { visibility: "shared", audience: aud };
            var n = R.unionDids(aud, ctx).length;
            note = n ? title + " is shared with " + n + (n === 1 ? " person" : " people") : title + " is shared, but nobody can open it yet";
          }
          this.saveEntry(entry, changes, function (err, saved) {
            if (err) return;
            var failed = saved && saved.shareFailed && saved.shareFailed.length;
            self.toast(failed ? note + ", but " + failed + (failed === 1 ? " person" : " people") + " could not be added yet" : note);
          });
        },
      },

      "import",
      {
        // True while an import is writing. The dialog uses it to refuse a second one, and so
        // does importGames itself (a double click on "Import" must not start two runs).
        isImporting: function () { return !!this._importing; },

        // Writes the part of a sync the owner confirmed: a NEW entry for each game in
        // `opts.selected`, and a refresh of the store's own facts (playtime, last played) on
        // each existing entry in `plan.refresh`. See lively.gaming.GamingImport for what a
        // plan is and for the rules (a refresh never touches status, rating, review,
        // visibility or the owner's own typed playtime).
        //   platform        'steam' | 'itch'
        //   plan            the object GamingImport.plan returned
        //   opts.selected   the plan.fresh candidates to create (the owner may have unticked some)
        //   opts.visibility 'private' | 'public' for the new entries (private unless the owner chose)
        //   opts.syncedAt   ISO time the candidates were fetched
        //   opts.onProgress(n, total)   after each job settles
        //   opts.isCancelled()          true once the owner pressed Stop
        // Calls thenDo(err, summary); err only for "cannot start", per-game failures are in
        // summary = { created, refreshed, skipped, failed: [{ job, error }], cancelled }.
        //
        // Idempotent on purpose, because the owner can press twice, run it in two tabs, or retry
        // after a failure: every job is re-checked against the library AT THE MOMENT it is about
        // to be written (GamingImport.runWrites' shouldSkip), not only when the preview was made.
        // A game already present by its store id is skipped, not written again. A game being
        // edited right now (a save is queued) is skipped for this run and refreshed by the next.
        importGames: function (platform, plan, opts, thenDo) {
          var self = this, GI = lively.gaming.GamingImport;
          if (!this.isOwner()) return thenDo(new Error("Only the owner can import games"));
          if (this._importing) return thenDo(new Error("An import is already running"));
          this._importing = true;

          var syncedAt = opts.syncedAt, visibility = opts.visibility === "public" ? "public" : "private";
          var counts = { created: 0, refreshed: 0 };

          // The store ids already in the library, kept current as this run creates entries.
          var have = {};
          this.state.entries.forEach(function (e) {
            var ids = (e.payload && e.payload.external_ids) || {};
            Object.keys(ids).forEach(function (p) { have[p + ":" + ids[p]] = true; });
          });
          var keyOf = function (c) { return c.platform + ":" + c.external_id; };

          var jobs = (opts.selected || []).map(function (c) { return { kind: "create", candidate: c }; })
            .concat((plan.refresh || []).map(function (r) { return { kind: "refresh", objId: r.entry.objId, candidate: r.candidate }; }));

          // Showing every created entry on screen as it lands would redraw the grid thousands of
          // times; coalesce to at most one redraw every 250 ms, and one at the end.
          var redrawTimer = null;
          function redrawSoon() {
            if (redrawTimer) return;
            redrawTimer = setTimeout(function () { redrawTimer = null; if (self._view) self._view.refresh(); }, 250);
          }

          GI.runWrites(jobs, {
            concurrency: GI.DEFAULT_CONCURRENCY,
            onProgress: opts.onProgress,
            isCancelled: opts.isCancelled,
            shouldSkip: function (job) {
              if (job.kind === "create") return !!have[keyOf(job.candidate)];
              var cur = self.entryById(job.objId);
              if (!cur) return true;                                   // removed meanwhile
              var q = self._saveQueues[job.objId];
              if (q && (q.running || q.pending)) return true;          // being edited right now
              return !GI.refreshChanges(cur.payload, job.candidate, syncedAt);
            },
            write: function (job, cb) {
              if (job.kind === "create") {
                have[keyOf(job.candidate)] = true;                     // claim it before the write lands
                GameLog().create(GI.fieldsOf(job.candidate, syncedAt, Date.now()), visibility, function (err, entry) {
                  if (err) { delete have[keyOf(job.candidate)]; return cb(err); }
                  self.state.entries.unshift(entry);
                  counts.created++;
                  redrawSoon();
                  cb(null);
                });
                return;
              }
              var cur = self.entryById(job.objId), ch = cur && GI.refreshChanges(cur.payload, job.candidate, syncedAt);
              if (!ch) return cb(null);
              GameLog().save(cur, ch, function (err, saved) {
                if (err) return cb(err);
                // The owner may have started editing this game while the write was in flight: do not
                // replace what they are typing (the same rule saveEntry follows).
                var q = self._saveQueues[saved.objId];
                if (!(q && (q.running || q.pending))) self._replaceEntry(saved);
                counts.refreshed++;
                cb(null);
              });
            },
          }, function (summary) {
            self._importing = false;
            clearTimeout(redrawTimer);
            if (self._view) self._view.refresh();
            thenDo(null, { created: counts.created, refreshed: counts.refreshed, skipped: summary.skipped, failed: summary.failed, cancelled: summary.cancelled });
          });
        },
      },

      "dialogs",
      {
        // The dialogs live in their own module, loaded the first time one is needed.
        _dialogs: function (thenDo) {
          lively.require("lively.gaming.GameDialogs").toRun(function () { thenDo(lively.gaming.GameDialogs); });
        },
        openAdd: function () { var self = this; this._dialogs(function (D) { D.openAdd(self); }); },
        openDetail: function (entry) { var self = this; this._dialogs(function (D) { D.openDetail(self, entry); }); },
        openVisibility: function (entry) { var self = this; this._dialogs(function (D) { D.openVisibility(self, entry); }); },
        // The import preview. It lives in its own module (it is the largest dialog and only
        // owners who linked an account ever open it).
        openImport: function () {
          var self = this;
          lively.require("lively.gaming.GameImportDialog").toRun(function () { lively.gaming.GameImportDialog.open(self); });
        },
      }
    );

    // Height of the strip the world's floating menu bar occupies at the top of the page.
    lively.gaming.Gaming.MENU_BAR_INSET = 48;

    // Opens the template in the current world, filling the visible area.
    lively.gaming.Gaming.open = function (optPos) {
      var m = new lively.gaming.Gaming(lively.rect(0, 0, 1280, 820));
      m.setName("Gaming");
      m.openInWorld(optPos || lively.morphic.World.current().visibleBounds().topLeft());
      // _setup ran from prepareForNewRenderContext as part of openInWorld, BEFORE the morph had an
      // owner chain, and openInWorld then re-positions it. Fit and lay out again now it is attached.
      m._fitToWorld();
      m._layout();
      return m;
    };
  }); // end module('lively.gaming.Gaming')
