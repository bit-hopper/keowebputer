/**
 * core/lively/identity/SettingsDialog.js
 *
 * The account Settings window (menu bar → Settings, and the gear on the
 * ambient presence panel). Tabs are pink pills, the same look as
 * ProfileCard.js's edit tabs; switching a tab rebuilds the pane (only one
 * tab's morphs exist at a time), like ConstellationSettingsDialog.js.
 *
 *   Account  — handle, DID, home instance, devices (from the DID document),
 *              sign out
 *   Privacy  — block list
 *   Feeds    — subscribed RSS feeds
 *   Connected — game-store accounts linked to this profile:
 *              connect (a full-page redirect through GameLinkServer, which
 *              brings the browser back with ?linked= / ?link_error=, handled
 *              by WorldTemplateLauncher.runIfLinkReturned) and disconnect
 *   Delete   — permanent account deletion: review → download + verify a .keo
 *              copy of your data → type your handle and use your passkey
 *              (settings.md §5, §5a). The Account tab also offers the download
 *              and the file check on their own.
 *
 * Privacy and Feeds both live in the account's settings envelope
 * (GET/PUT /@:handle/settings), read and written through DID.js's shared
 * relationships helpers (_loadRelationships / _patchRelationships /
 * blockDid / unblockDid) so there is one copy of the mutate-and-PUT dance.
 * The Mailbox window keeps its own Blocked / RSS tabs over the same envelope;
 * this dialog re-reads the envelope each time one of its tabs is opened, so
 * the two never act on a stale copy.
 *
 * Open: lively.identity.SettingsDialog.open(tab, notice)
 *   tab: "account" (default), "privacy", "feeds", "security", "connected" or "delete"
 *   notice: optional { ok: bool, text } shown at the top of the Connected tab
 *           (the result of a connect attempt that just returned)
 *
 * See settings.md for the spec (export / delete-account tabs are added there).
 */

module("lively.identity.SettingsDialog")
  .requires(
    "lively.identity.DID",
    "lively.identity.KeyVault",
    "lively.identity.WebKey",
    "lively.identity.MenuBarEntry",
    "lively.identity.KeoReader",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    lively.BuildSpec("lively.identity.SettingsDialog", {
      _BorderRadius: 7,
      _Extent: lively.pt(540, 520),
      _Fill: Color.rgb(204, 0, 87),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "SettingsDialog",
      titleBar: "Settings",
      submorphs: [
        {
          _BorderColor: Color.rgb(95, 94, 95),
          _BorderRadius: 4,
          _BorderWidth: 1,
          _Extent: lively.pt(534, 495),
          _Fill: Color.rgb(243, 243, 243),
          // Must equal contentOffset: a BuildSpec-declared content pane is
          // not positioned by it automatically (CLAUDE.md).
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          clipMode: "auto",
          layout: { adjustForNewBounds: true, resizeWidth: true, resizeHeight: true },
          name: "settingsContent",
          submorphs: [],
        },
      ],

      // ─── lifecycle ────────────────────────────────────────────────────────

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        $super();
        this._tab = "account";
        this._didDoc = null;
        this._didDocError = null;
        this._relLoaded = false;
        this._summary = null;
        this._summaryError = null;
        this._resetDelete();
      },

      // Delete flow state. _dstep: "review" | "export" | "confirm".
      _resetDelete: function _resetDelete() {
        this._dstep = "review";
        this._exportRequested = false;
        this._verifyResult = null;
        this._verifying = false;
        this._skipExport = false;
        this._deleted = false;
      },

      load: function load(tab) {
        this._tab = (tab === "privacy" || tab === "feeds" || tab === "security" || tab === "connected" || tab === "delete") ? tab : "account";
        this._enterTab();
      },

      // Kicks off whatever data the current tab needs, then renders. The tab
      // renders at once (with a "Loading…" note where data is missing) and
      // again when the data lands.
      _enterTab: function _enterTab() {
        var self = this;
        var tab = this._tab;
        var did = lively.identity.did;
        if (tab === "account" || tab === "delete") {
          if (tab === "delete") this._resetDelete();
          this._render();
          if (tab === "account" && !this._didDoc) this._loadDidDocument();
          this._loadSummary();
        } else if (tab === "security") {
          this._render();
        } else if (tab === "connected") {
          this._render();
          this._loadLinked();
        } else {
          this._relLoaded = false;
          this._render();
          did._loadRelationships(function () {
            if (self._tab !== tab) return;
            self._relLoaded = true;
            self._render();
          });
        }
      },

      // What the account holds (GET /@:handle/account/summary): shown on the
      // Account tab and in the delete flow, and compared with a downloaded file.
      _loadSummary: function _loadSummary(thenDo) {
        var self = this;
        var did = lively.identity.did;
        var user = did.currentUser();
        if (!user || !user.handle) return;
        fetch(did.baseUrl() + "/@" + encodeURIComponent(user.handle) + "/account/summary", { credentials: "include" })
          .then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
          })
          .then(function (summary) {
            self._summary = summary;
            self._summaryError = null;
            if (thenDo) thenDo(null, summary);
            else if (self._tab === "account" || self._tab === "delete") self._render();
          })
          .catch(function (err) {
            self._summaryError = String(err.message || err);
            if (thenDo) thenDo(err);
            else if (self._tab === "account" || self._tab === "delete") self._render();
          });
      },

      _loadDidDocument: function _loadDidDocument() {
        var self = this;
        var did = lively.identity.did;
        var user = did.currentUser();
        if (!user || !user.handle) return;
        fetch(did.baseUrl() + "/@" + encodeURIComponent(user.handle) + "/did-document", { credentials: "include" })
          .then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
          })
          .then(function (doc) {
            self._didDoc = doc;
            self._didDocError = null;
            if (self._tab === "account") self._render();
          })
          .catch(function (err) {
            self._didDocError = String(err.message || err);
            if (self._tab === "account") self._render();
          });
      },

      // ─── render ─────────────────────────────────────────────────────────────

      _render: function _render() {
        var self = this;
        var did = lively.identity.did;
        var user = did.currentUser();
        var content = this.get("settingsContent");
        content.removeAllMorphs();
        var MARGIN = 18;
        var ew = 498;
        var BTN_W = 96;
        var GAP = 10;
        var inputW = ew - BTN_W - GAP;
        var ROW_H = 30;
        var y = 14;
        var tab = this._tab || "account";
        var PINK = Color.rgb(204, 0, 87);

        function sectionLabel(str) {
          var lbl = new lively.morphic.Text(lively.rect(MARGIN, y, ew, 16), str);
          lbl.applyStyle({ allowInput: false, fontSize: 12, fontWeight: "bold",
            textColor: Color.rgb(80, 80, 80), fill: null, borderWidth: 0 });
          content.addMorph(lbl);
          y += 22;
        }

        function noteText(str, h) {
          var lbl = new lively.morphic.Text(lively.rect(MARGIN, y, ew, h || 16), str);
          lbl.applyStyle({ allowInput: false, fontSize: 10,
            textColor: Color.rgb(140, 140, 148), fill: null, borderWidth: 0 });
          content.addMorph(lbl);
          y += (h || 16) + 6;
        }

        // Wrapped text. Height is a generous per-line estimate (18px a line for
        // this font size, per CLAUDE.md: guessed heights undershoot, so err tall)
        // — the box has no fill or border, so spare height is invisible.
        function paragraph(str, color, size) {
          var CPL = 68; // characters per line at fontSize 10 across `ew`
          var lines = Math.max(1, Math.ceil(str.length / CPL));
          var h = lines * 18 + 4;
          var lbl = new lively.morphic.Text(lively.rect(MARGIN, y, ew, h), str);
          lbl.applyStyle({ allowInput: false, fontSize: size || 10, fixedWidth: true, fixedHeight: true,
            whiteSpaceHandling: "normal", textColor: color || Color.rgb(100, 100, 108), fill: null, borderWidth: 0 });
          lbl.setExtent(lively.pt(ew, h));
          content.addMorph(lbl);
          y += h + 6;
          return lbl;
        }

        function divider() {
          y += 8;
          var line = new lively.morphic.Box(lively.rect(MARGIN, y, ew, 1));
          line.applyStyle({ fill: Color.rgb(228, 228, 228), borderWidth: 0 });
          content.addMorph(line);
          y += 20;
        }

        function truncateMiddle(str, head, tail) {
          if (!str) return "";
          if (str.length <= head + tail + 1) return str;
          return str.slice(0, head) + "…" + str.slice(-tail);
        }

        // variant: "default" (neutral gray), "accent" (pink), "danger" (red).
        // Hover fill is a direct onMouseOver assignment, not addScript, so it
        // keeps its closure over `palette`.
        function styledButton(rect, label, variant) {
          var palette = {
            "default": { fill: Color.rgb(247, 247, 250), hoverFill: Color.rgb(236, 236, 243),
              border: Color.rgb(223, 223, 233), text: Color.rgb(70, 70, 80) },
            "accent": { fill: Color.rgb(253, 236, 243), hoverFill: Color.rgb(250, 219, 232),
              border: Color.rgb(240, 190, 210), text: PINK },
            "danger": { fill: Color.rgb(253, 238, 240), hoverFill: Color.rgb(250, 223, 227),
              border: Color.rgb(240, 200, 206), text: Color.rgb(180, 40, 60) },
          }[variant || "default"];
          var btn = new lively.morphic.Button(rect, label);
          btn.applyStyle({ fill: palette.fill,
            borderColor: palette.border, borderRadius: 8,
            fontSize: 11, textColor: palette.text, borderWidth: 1 });
          btn.setAppearanceStylingMode(false);
          btn.setBorderStylingMode(false);
          btn._textColor = palette.text;   // written to the DOM in the post-pass below
          if (btn.label && btn.label.setTextColor) btn.label.setTextColor(palette.text);
          btn.onMouseOver = function () { btn.applyStyle({ fill: palette.hoverFill }); };
          btn.onMouseOut = function () { btn.applyStyle({ fill: palette.fill }); };
          return btn;
        }

        // The button carries what to call and with what (_action/_arg), so the
        // addScript body only references `this` — no closure over anything in
        // this method (CLAUDE.md: addScript bodies lose their closure).
        function actionButton(x, rowY, w, label, variant, action, arg) {
          var btn = styledButton(lively.rect(x, rowY, w, 24), label, variant);
          btn._action = action;
          btn._arg = arg;
          btn._label0 = label;
          btn.addScript(function doAction() {
            var win = this.owner && this.owner.owner;
            if (!win || !win[this._action]) return;
            this.setLabel("…");
            this.setActive(false);
            win[this._action](this._arg, this);
          });
          lively.bindings.connect(btn, "fire", btn, "doAction");
          content.addMorph(btn);
          return btn;
        }

        // Single-line editable field, same recipe as ConstellationSettingsDialog:
        // fixedWidth/fixedHeight + clipMode so a long pasted URL stays inside
        // its box, applyStyle after beInputLine(), extent re-asserted.
        function textField(name, value, w) {
          var inp = new lively.morphic.Text(lively.rect(MARGIN, y, w, 28), value || "");
          inp.name = name;
          inp.beInputLine();
          inp.applyStyle({ allowInput: true, fontSize: 12, clipMode: "hidden",
            fixedWidth: true, fixedHeight: true, whiteSpaceHandling: "pre",
            fill: Color.rgb(252, 252, 252),
            borderColor: Color.rgb(200, 200, 200), borderWidth: 1, borderRadius: 4 });
          inp.setExtent(lively.pt(w, 28));
          content.addMorph(inp);
          return inp;
        }

        // A label (left) and a value (right of it), optional right-aligned button.
        function infoRow(label, value, btn) {
          var LBL_W = 118;
          var lbl = new lively.morphic.Text(lively.rect(MARGIN, y + 3, LBL_W, 20), label);
          lbl.applyStyle({ allowInput: false, fontSize: 11,
            textColor: Color.rgb(140, 140, 148), fill: null, borderWidth: 0 });
          content.addMorph(lbl);
          var valW = ew - LBL_W - (btn ? BTN_W + GAP : 0);
          var val = new lively.morphic.Text(lively.rect(MARGIN + LBL_W, y + 3, valW, 20), value);
          val.applyStyle({ allowInput: false, fontSize: 12, clipMode: "hidden",
            textColor: Color.rgb(50, 50, 58), fill: null, borderWidth: 0 });
          content.addMorph(val);
          if (btn) actionButton(MARGIN + ew - BTN_W, y, BTN_W, btn.label, "default", btn.action, btn.arg);
          y += ROW_H;
        }

        // ── Tab row ──────────────────────────────────────────────────────────
        // Same shape and colours as ProfileCard.js's edit tabs. Label colour is
        // recorded on the button (_textColor) and written to the DOM in the
        // post-pass at the end of _render, since applyStyle's textColor never
        // reaches a Button's label (CLAUDE.md).
        function addTabButton(label, tabName, x, w) {
          var isActive = tab === tabName;
          var tb = new lively.morphic.Button(lively.rect(x, y, w, 28), label);
          tb.applyStyle({
            fill: isActive ? PINK : Color.rgb(255, 255, 255),
            borderColor: isActive ? PINK : Color.rgb(222, 222, 228),
            borderRadius: 14, fontSize: 11, borderWidth: 1,
          });
          tb.setAppearanceStylingMode(false);
          tb.setBorderStylingMode(false);
          tb._textColor = isActive ? Color.white : Color.rgb(90, 90, 98);
          if (tb.label && tb.label.setTextColor) tb.label.setTextColor(tb._textColor);
          tb._targetTab = tabName;
          tb.addScript(function doAction() {
            var win = this.owner && this.owner.owner;
            if (win) win._switchTab(this._targetTab);
          });
          lively.bindings.connect(tb, "fire", tb, "doAction");
          content.addMorph(tb);
        }
        // Six tabs across the 498px content width: 78px each, 6px apart.
        addTabButton("Account", "account", MARGIN, 78);
        addTabButton("Privacy", "privacy", MARGIN + 84, 78);
        addTabButton("Feeds", "feeds", MARGIN + 168, 78);
        addTabButton("Security", "security", MARGIN + 252, 78);
        addTabButton("Connected", "connected", MARGIN + 336, 78);
        addTabButton("Delete", "delete", MARGIN + 420, 78);
        y += 28 + 22;

        if (!user || !user.handle) {
          noteText("Sign in to change your settings.");
        } else if (tab === "account") {

          // ── Account tab ───────────────────────────────────────────────────
          sectionLabel("Identity");
          infoRow("Handle", "@" + user.handle);
          if (user.domainHandle) infoRow("Domain handle", user.domainHandle);
          infoRow("DID", truncateMiddle(user.did, 22, 10),
            { label: "Copy DID", action: "_copyDid", arg: user.did });
          var doc = this._didDoc;
          var home = null;
          if (doc && Array.isArray(doc.service)) {
            doc.service.forEach(function (s) {
              if (s && typeof s.id === "string" && /#home$/.test(s.id)) home = s.serviceEndpoint;
            });
          }
          infoRow("Home instance", home || (doc ? "Not recorded" : (this._didDocError ? "Could not load" : "Loading…")));
          divider();

          sectionLabel("Devices");
          if (!doc) {
            noteText(this._didDocError ? "Could not load your DID document (" + this._didDocError + ")." : "Loading…");
          } else {
            var methods = Array.isArray(doc.verificationMethod) ? doc.verificationMethod : [];
            if (!methods.length) noteText("No devices recorded.");
            methods.forEach(function (vm) {
              var meta = (vm && vm.lively) || {};
              var added = meta.addedAt ? new Date(meta.addedAt).toLocaleDateString() : "";
              var row = new lively.morphic.Text(lively.rect(MARGIN, y + 3, ew, 20),
                (meta.deviceLabel || "Device") + (added ? "  —  added " + added : ""));
              row.applyStyle({ allowInput: false, fontSize: 12, clipMode: "hidden",
                textColor: Color.rgb(50, 50, 58), fill: null, borderWidth: 0 });
              content.addMorph(row);
              y += 24;
            });
            noteText("Devices are the passkeys that can sign in as you. This list comes from your DID document.", 28);
          }
          divider();

          sectionLabel("Your data");
          var sm = this._summary;
          if (!sm) {
            noteText(this._summaryError ? "Could not load a summary (" + this._summaryError + ")." : "Loading…");
          } else {
            noteText(sm.objects + " objects (" + sm.versions + " saved versions), " + sm.blobs + " uploaded files, " +
              sm.files + " legacy files, " + sm.friends + " friends.", 30);
          }
          paragraph("Download everything this server stores about you as one .keo file. Private content stays encrypted, " +
            "so you need your passkey to read it later.");
          actionButton(MARGIN, y, 150, "Download my data", "accent", "_downloadExport", null);
          actionButton(MARGIN + 160, y, 150, "Check a download…", "default", "_pickAndVerify", null);
          y += 36;
          if (this._verifyResult) {
            var vr0 = this._verifyResult;
            paragraph(vr0.ok ? "✓ This file is complete and matches its manifest." : "✗ " + vr0.problems.slice(0, 4).join("  "),
              vr0.ok ? Color.rgb(20, 120, 60) : Color.rgb(180, 40, 60));
          }
          divider();

          sectionLabel("Session");
          actionButton(MARGIN, y, BTN_W, "Sign out", "danger", "_signOut", null);
          y += 36;

        } else if (tab === "delete") {

          // ── Delete tab ─────────────────────────────────────────────────────
          var RED = Color.rgb(180, 40, 60);
          var smm = this._summary;
          sectionLabel("Delete account");
          if (this._deleted) {
            paragraph("Your account has been deleted. Signing you out…", RED, 11);
          } else if (!smm) {
            noteText(this._summaryError ? "Could not load your account summary (" + this._summaryError + ")." : "Loading…");
          } else if (this._dstep === "review") {
            paragraph("This permanently deletes @" + user.handle + " and everything this server holds for it: " +
              smm.objects + " objects (" + smm.versions + " saved versions: postcards, wiki pages, worlds and so on), " + smm.blobs +
              " uploaded files, " + smm.friends + " friendships, and your comments, reactions and stars on other people's content. It cannot be undone. " +
              "Your handle stays reserved, so nobody else can ever register it.", Color.rgb(60, 60, 68), 11);
            if (smm.blockedBy && smm.blockedBy.length) {
              paragraph("You created " + (smm.blockedBy.length === 1 ? "this constellation" : "these constellations") + ": " +
                smm.blockedBy.join(", ") + ". They can't be deleted or handed to someone else yet, so this account can't be " +
                "deleted while they exist.", RED, 11);
            }
            sectionLabel("Before you go");
            paragraph("Wallet: your encrypted wallet backup is stored with your account and is deleted with it. Export your " +
              "wallet first, or you could lose access to its funds.");
            if (smm.domains) paragraph("Domain: you have a verified domain. After deleting, remove its _lively-did DNS record.");
            paragraph("Messages: your direct-message history is kept only in this browser. Deleting your account does not " +
              "touch it, and it cannot be recovered from the server.");
            paragraph("Passkey: if you download your data, keep your passkey. It is the only thing that can decrypt it; " +
              "removing the passkey makes the download permanently unreadable.");
            if (!(smm.blockedBy && smm.blockedBy.length)) {
              actionButton(MARGIN, y, 130, "Continue", "danger", "_deleteStep", "export");
              y += 36;
            }
          } else if (this._dstep === "export") {
            paragraph("Step 1 of 2. Download a copy of your data, then pick the downloaded file so it can be checked. " +
              "Deletion is permanent and this is your last chance to keep it.", Color.rgb(60, 60, 68), 11);
            actionButton(MARGIN, y, 150, "Download my data", "accent", "_downloadExport", null);
            actionButton(MARGIN + 160, y, 200, "Check the file I downloaded…", "default", "_pickAndVerify", null);
            y += 36;
            if (this._exportRequested && !this._verifyResult) {
              paragraph("Your download should have started. When it has finished, use “Check the file I downloaded…”.");
            }
            if (this._verifying) {
              var vs = new lively.morphic.Text(lively.rect(MARGIN, y, ew, 18), "Checking…");
              vs.name = "sdVerifyStatus";
              vs.applyStyle({ allowInput: false, fontSize: 10, textColor: Color.rgb(100, 100, 108), fill: null, borderWidth: 0 });
              content.addMorph(vs);
              y += 24;
            }
            var vr = this._verifyResult;
            if (vr) {
              if (vr.ok) {
                paragraph("✓ Checked: this file is complete and matches its manifest" +
                  (vr.counts ? " (" + vr.counts.objects + " objects, " + vr.counts.versions + " versions, " + vr.counts.blobs + " files)." : "."),
                  Color.rgb(20, 120, 60), 11);
              } else {
                paragraph("✗ This file can't be trusted: " + vr.problems.slice(0, 5).join("  "), RED, 11);
              }
              vr.warnings.slice(0, 4).forEach(function (w) { paragraph("Note: " + w, Color.rgb(150, 110, 20)); });
            }
            y += 4;
            if (vr && vr.ok) {
              actionButton(MARGIN, y, 130, "Continue", "danger", "_deleteStep", "confirm");
            }
            actionButton(MARGIN + (vr && vr.ok ? 140 : 0), y, 190, "Continue without a copy", "default", "_skipExportStep", null);
            actionButton(MARGIN + ew - 90, y, 90, "Back", "default", "_deleteStep", "review");
            y += 36;
          } else {
            paragraph("Step 2 of 2. This is the last step. " + (this._skipExport ? "You chose not to keep a copy of your data. " : "") +
              "Type your handle to confirm, then approve with your passkey.", Color.rgb(60, 60, 68), 11);
            noteText("Type " + user.handle + " to confirm");
            textField("sdConfirmHandle", "", inputW);
            actionButton(MARGIN + ew - BTN_W, y + 2, BTN_W, "Delete forever", "danger", "_deleteNow", null);
            y += 40;
            actionButton(MARGIN, y, 90, "Back", "default", "_deleteStep", "export");
            y += 36;
          }

        } else if (tab === "security") {

          // ── Security tab ──────────────────────────────────────────────────
          sectionLabel("Stay unlocked");
          var kv = lively.identity.keyVault;
          if (!kv.isSupported()) {
            noteText("This browser can't do this (it needs IndexedDB and Web Crypto).", 16);
          } else {
            var kvOn = kv.isEnabled();
            paragraph("Normally your passkey is asked for again after every page load. Turn this on to stay unlocked in this tab " +
              "across page loads, for up to 8 hours. Closing the tab, signing out or turning this off locks it again. " +
              "While it is on, anyone using this tab can read your private content, so leave it off on a shared computer.");
            infoRow("Status", kvOn ? "On for this browser" : "Off");
            y += 6;
            actionButton(MARGIN, y, 150, kvOn ? "Turn off" : "Turn on", kvOn ? "default" : "accent", "_toggleKeepUnlocked", null);
            y += 36;
          }

        } else if (tab === "connected") {

          // ── Connected tab ─────────────────────────────────────────────────
          // One card per store. What the copy says must stay true to what
          // GameLinkServer.js actually does: it links and unlinks, and holds
          // nothing else yet (importing a library is not built).
          var GREEN = Color.rgb(20, 120, 60);
          var REDC = Color.rgb(180, 40, 60);
          if (this._notice) {
            paragraph(this._notice.text, this._notice.ok ? GREEN : REDC, 11);
          }
          var lk = this._linked;
          var STORES = [
            { key: "steam", name: "Steam",
              keeps: "We keep: your public Steam ID, nothing else. No password and no token, because Steam sign-in only proves " +
                "who you are. We don't read your game list yet; when importing arrives it will only run when you press Sync.",
              before: "Steam's own page asks you to sign in; we never see your password. Not affiliated with or endorsed by Valve or Steam." },
            { key: "itch", name: "itch.io",
              keeps: "We keep: an encrypted access token on our server until you disconnect. We don't read anything with it yet; " +
                "when importing arrives it will list the games you own (itch.io does not provide playtime).",
              before: "itch.io will ask you to let us read your profile and the games you own. You can revoke this on itch.io " +
                "at any time, and Disconnect here revokes it too." },
          ];
          if (!lk) {
            noteText(this._linkedError ? "Could not load your linked accounts (" + this._linkedError + ")." : "Loading…");
          } else {
            STORES.forEach(function (st, i) {
              if (i) divider();
              sectionLabel(st.name);
              var acct = null;
              (lk.accounts || []).forEach(function (a) { if (a.platform === st.key) acct = a; });
              var avail = (lk.providers && lk.providers[st.key]) || { available: false, reason: null };
              if (acct) {
                var who = acct.display_name || (st.key === "steam" ? "Steam ID " + acct.external_id : "Account " + acct.external_id);
                infoRow("Connected as", who, { label: "Disconnect", action: "_disconnect", arg: st.key });
                infoRow("Linked", acct.linked_at ? new Date(acct.linked_at).toLocaleDateString() : "");
                infoRow("Last synced", acct.last_synced_at ? new Date(acct.last_synced_at).toLocaleString() : "Never");
                if (acct.status && acct.status !== "active") {
                  paragraph("This link needs attention (" + acct.status.replace(/_/g, " ") + "). Disconnect and connect again.", REDC, 10);
                }
                paragraph(st.keeps);
              } else {
                paragraph(st.before);
                if (avail.available) {
                  actionButton(MARGIN, y, 150, "Connect " + st.name, "accent", "_connect", st.key);
                  y += 36;
                } else {
                  noteText("Unavailable on this server" + (avail.reason ? ": " + avail.reason : "") + ".", 28);
                }
              }
            });
            divider();
            sectionLabel("Xbox");
            noteText("Coming soon.");
            sectionLabel("PlayStation");
            paragraph("Not available: PlayStation has no public way for other apps to read your library. Add those games by hand.");
          }

        } else if (!this._relLoaded) {
          noteText("Loading…");

        } else if (tab === "privacy") {

          // ── Privacy tab ───────────────────────────────────────────────────
          sectionLabel("Blocked accounts");
          noteText("Postcards and replies from a blocked account are returned to the sender.", 28);
          textField("sdBlockHandle", "", inputW);
          actionButton(MARGIN + ew - BTN_W, y + 2, BTN_W, "Block", "danger", "_blockFromField", null);
          y += 36;
          var blocked = (did._relationships && did._relationships.blockedHandles) || [];
          if (!blocked.length) noteText("No blocked accounts.");
          blocked.forEach(function (h) {
            var lbl = new lively.morphic.Text(lively.rect(MARGIN, y + 3, ew - BTN_W - GAP, 20), "@" + h);
            lbl.applyStyle({ allowInput: false, fontSize: 12, clipMode: "hidden",
              textColor: Color.rgb(50, 50, 58), fill: null, borderWidth: 0 });
            content.addMorph(lbl);
            actionButton(MARGIN + ew - BTN_W, y, BTN_W, "Unblock", "default", "_unblock", h);
            y += ROW_H;
          });
          y += 12;

        } else {

          // ── Feeds tab ─────────────────────────────────────────────────────
          sectionLabel("RSS feeds");
          noteText("Feeds you subscribe to appear in the Mailbox's RSS tab.", 28);
          textField("sdFeedUrl", "", inputW);
          actionButton(MARGIN + ew - BTN_W, y + 2, BTN_W, "Add", "accent", "_addFeedFromField", null);
          y += 36;
          var env = did._relationshipsEnvelope;
          var feeds = (env && env.state && env.state.rssFeeds) || [];
          if (!feeds.length) noteText("No feeds yet. Paste a feed URL above (https://…).");
          feeds.forEach(function (f) {
            var lbl = new lively.morphic.Text(lively.rect(MARGIN, y + 3, ew - BTN_W - GAP, 20), f.url);
            lbl.applyStyle({ allowInput: false, fontSize: 12, clipMode: "hidden",
              textColor: Color.rgb(50, 50, 58), fill: null, borderWidth: 0 });
            content.addMorph(lbl);
            actionButton(MARGIN + ew - BTN_W, y, BTN_W, "Remove", "danger", "_removeFeed", f.url);
            y += ROW_H;
          });
          y += 12;
        }

        // Post-pass: applyStyle's textColor never reaches a Button's label
        // (CLAUDE.md), so write each styled button's recorded colour to its
        // rendered label.
        content.submorphs.forEach(function (m) {
          if (!m._textColor || !m.label) return;
          try {
            var ln = m.label.renderContext().shapeNode;
            var c = m._textColor.toString();
            ln.style.color = c;
            Array.prototype.forEach.call(ln.querySelectorAll("div, span"), function (n) { n.style.color = c; });
          } catch (e) {}
        });

        // Grow the window (never shrink it — a user's manual resize must
        // survive an async re-render) if this tab's content needs more room.
        var neededHeight = Math.min(640, y + (this.contentOffset ? this.contentOffset.y : 22) + 6);
        if (neededHeight > this.getExtent().y) {
          this.setExtent(lively.pt(this.getExtent().x, neededHeight));
        }
      },

      // ─── connected accounts ──────────────────────────────────────────────────

      // GET /nodejs/GameLinkServer/status: which stores this server offers and which
      // accounts are linked. Never carries a credential.
      _loadLinked: function _loadLinked() {
        var self = this;
        fetch("/nodejs/GameLinkServer/status", { credentials: "include", headers: { "Accept": "application/json" } })
          .then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
          })
          .then(function (data) {
            self._linked = data;
            self._linkedError = null;
            if (self._tab === "connected") self._render();
          })
          .catch(function (err) {
            self._linkedError = String(err.message || err);
            if (self._tab === "connected") self._render();
          });
      },

      // A full-page redirect through the server (not a popup): it works on a phone and
      // survives the reload. The server brings the browser back to this page with
      // ?linked= or ?link_error=. Anything unsaved in the world is lost to the reload,
      // so ask first.
      _connect: function _connect(platform, btn) {
        var self = this;
        $world.confirm("Connecting leaves this page and comes back. Save your world first if it has unsaved changes. Continue?", function (ok) {
          if (!ok) return self._restore(btn);
          var back = window.location.pathname + window.location.search;
          window.location.href = "/nodejs/GameLinkServer/start/" + encodeURIComponent(platform) + "?return=" + encodeURIComponent(back);
        });
      },

      _disconnect: function _disconnect(platform, btn) {
        var self = this;
        var names = { steam: "Steam", itch: "itch.io" };
        $world.confirm("Disconnect " + (names[platform] || platform) + "? The saved link" +
          (platform === "itch" ? " and its access token are deleted and the token is revoked at itch.io" : " is deleted") +
          ". Games already in your library stay.", function (ok) {
          if (!ok) return self._restore(btn);
          fetch("/nodejs/GameLinkServer/" + encodeURIComponent(platform), {
            method: "DELETE", credentials: "include", headers: { "Accept": "application/json" },
          })
            .then(function (res) {
              if (!res.ok) throw new Error("HTTP " + res.status);
              return res.json();
            })
            .then(function (body) {
              self._notice = {
                ok: true,
                text: (names[platform] || platform) + " disconnected." +
                  (platform === "itch" && body && body.wasLinked && !body.revoked ? " The token could not be revoked at itch.io right now; you can revoke it in your itch.io settings." : ""),
              };
              self._loadLinked();
            })
            .catch(function (err) {
              self._restore(btn);
              $world.alert("Could not disconnect: " + String(err.message || err));
            });
        });
      },

      // ─── actions ────────────────────────────────────────────────────────────

      _switchTab: function _switchTab(tab) {
        if (tab === this._tab) return;
        this._notice = null;
        this._tab = tab;
        this._enterTab();
      },

      // A failed action puts its button back.
      _restore: function _restore(btn) {
        if (btn && btn._label0) { btn.setLabel(btn._label0); btn.setActive(true); }
      },

      _fieldValue: function _fieldValue(name) {
        var inp = this.get("settingsContent").get(name);
        return ((inp && inp.textString) || "").trim();
      },

      // Same clipboard approach as ConstellationSettingsDialog's Copy DID.
      _copyDid: function _copyDid(text, btn) {
        function copied() {
          btn.setLabel("Copied!");
          setTimeout(function () { btn.setLabel("Copy DID"); btn.setActive(true); }, 1200);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text || "").then(copied).catch(function () { btn.setLabel("Copy DID"); btn.setActive(true); });
        } else {
          var ta = document.createElement("textarea");
          ta.value = text || "";
          ta.style.cssText = "position:fixed;opacity:0;";
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); copied(); } catch (e) { btn.setLabel("Copy DID"); btn.setActive(true); }
          document.body.removeChild(ta);
        }
      },

      // Turning it on stores whatever is unlocked right now; turning it off
      // deletes every stored copy (in every tab).
      _toggleKeepUnlocked: function _toggleKeepUnlocked(arg, btn) {
        var self = this;
        var kv = lively.identity.keyVault;
        var turnOn = !kv.isEnabled();
        kv.setEnabled(turnOn).then(function (ok) {
          if (ok && turnOn && lively.identity.webAuthn) lively.identity.webAuthn.persistCachesToVault();
          self._restore(btn);
          self._render();
        });
      },

      _signOut: function _signOut(arg, btn) {
        this._restore(btn);
        lively.identity.MenuBarEntry.signOut();
      },

      // ─── data export and account deletion ─────────────────────────────────
      // Each passkey prompt comes straight from a button click and is never
      // chained from another ceremony (settings.md §5).

      _deleteStep: function _deleteStep(step, btn) {
        this._restore(btn);
        this._dstep = step;
        this._render();
      },

      _skipExportStep: function _skipExportStep(arg, btn) {
        var self = this;
        this._restore(btn);
        $world.confirm("Delete your account without keeping a copy of your data? You won't be able to get it back.", function (ok) {
          if (!ok) return;
          self._skipExport = true;
          self._dstep = "confirm";
          self._render();
        });
      },

      // Passkey prompt -> single-use token -> the browser downloads the .keo.
      _downloadExport: function _downloadExport(arg, btn) {
        var self = this;
        var did = lively.identity.did;
        var user = did.currentUser();
        lively.identity.SettingsDialog.freshAssertion(function (err, assertion) {
          if (err) { alert("Could not confirm with your passkey: " + err.message); return self._restore(btn); }
          fetch(did.baseUrl() + "/@" + encodeURIComponent(user.handle) + "/account/export-token", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ assertion: assertion }),
          })
            .then(function (res) {
              return res.json().then(function (body) {
                if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
                return body;
              });
            })
            .then(function (body) {
              var a = document.createElement("a");
              a.href = did.baseUrl() + "/@" + encodeURIComponent(user.handle) + "/account/export?token=" + encodeURIComponent(body.token);
              a.download = "";
              a.style.display = "none";
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              self._exportRequested = true;
              self._verifyResult = null;
              self._restore(btn);
              self._render();
            })
            .catch(function (err2) {
              alert("Could not start the download: " + err2.message);
              self._restore(btn);
            });
        });
      },

      // Opens the file picker, checks the chosen .keo against its own manifest
      // and against what the server holds right now.
      _pickAndVerify: function _pickAndVerify(arg, btn) {
        var self = this;
        this._restore(btn);
        var input = document.createElement("input");
        input.type = "file";
        input.accept = ".keo";
        input.style.display = "none";
        input.addEventListener("change", function () {
          var file = input.files && input.files[0];
          if (input.parentNode) input.parentNode.removeChild(input);
          if (!file) return;
          self._verifying = true;
          self._verifyResult = null;
          self._render();
          var reader = lively.identity.KeoReader;
          reader.verify(file, function (msg) {
            var t = self.get("settingsContent").get("sdVerifyStatus");
            if (t) t.textString = msg;
          })
            .then(function (result) {
              self._loadSummary(function (err, summary) {
                if (summary) {
                  reader.compareWithSummary(result.manifest, summary).forEach(function (d) { result.problems.push(d); });
                  result.ok = result.problems.length === 0;
                } else {
                  result.warnings.push("Couldn't compare the file with your current account data.");
                }
                self._verifying = false;
                self._verifyResult = result;
                self._render();
              });
            })
            .catch(function (err) {
              self._verifying = false;
              self._verifyResult = { ok: false, problems: ["Couldn't read the file: " + (err && err.message || err)], warnings: [], manifest: null, counts: null };
              self._render();
            });
        });
        document.body.appendChild(input);
        input.click();
      },

      _deleteNow: function _deleteNow(arg, btn) {
        var self = this;
        var did = lively.identity.did;
        var user = did.currentUser();
        var typed = this._fieldValue("sdConfirmHandle").replace(/^@/, "");
        if (typed !== user.handle) {
          alert("Type your handle (" + user.handle + ") exactly to confirm.");
          return this._restore(btn);
        }
        lively.identity.SettingsDialog.freshAssertion(function (err, assertion) {
          if (err) { alert("Could not confirm with your passkey: " + err.message); return self._restore(btn); }
          fetch(did.baseUrl() + "/@" + encodeURIComponent(user.handle) + "/account/delete", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirmHandle: typed, assertion: assertion }),
          })
            .then(function (res) {
              return res.json().then(function (body) {
                if (!res.ok) { var e = new Error(body.error || ("HTTP " + res.status)); e.body = body; throw e; }
                return body;
              });
            })
            .then(function () {
              self._deleted = true;
              self._render();
              setTimeout(function () { lively.identity.MenuBarEntry.finishSignOut(); }, 1800);
            })
            .catch(function (err2) {
              if (err2.body && err2.body.code === "BLOCKED") {
                alert("Your account can't be deleted yet: you created " + err2.body.constellations.join(", ") + ".");
                self._loadSummary();
              } else {
                alert("Could not delete the account: " + err2.message);
              }
              self._restore(btn);
            });
        });
      },

      _blockFromField: function _blockFromField(arg, btn) {
        var self = this;
        var did = lively.identity.did;
        var handle = this._fieldValue("sdBlockHandle").replace(/^@/, "").toLowerCase();
        if (!handle) { alert("Enter a handle first."); return this._restore(btn); }
        var me = did.currentUser();
        if (me && handle === me.handle) { alert("You can't block yourself."); return this._restore(btn); }
        lively.identity.webKey.resolveHandle(handle, function (err, info) {
          var targetDid = (!err && info) ? info.did : null;
          did.blockDid(targetDid, handle, function (err2) {
            if (err2) { alert("Could not block: " + err2.message); return self._restore(btn); }
            self._render();
          });
        });
      },

      // The server matches blocks on blockedDids as well as blockedHandles, so
      // the DID has to come out too (Mailbox's _unblockHandle does the same).
      _unblock: function _unblock(handle, btn) {
        var self = this;
        var did = lively.identity.did;
        lively.identity.webKey.resolveHandle(handle, function (err, info) {
          var targetDid = (!err && info) ? info.did : null;
          did.unblockDid(targetDid, handle, function (err2) {
            if (err2) { alert("Could not unblock: " + err2.message); return self._restore(btn); }
            self._render();
          });
        });
      },

      _addFeedFromField: function _addFeedFromField(arg, btn) {
        var self = this;
        var url = this._fieldValue("sdFeedUrl");
        if (!/^https?:\/\/\S+$/i.test(url)) {
          alert("Enter a feed URL starting with http:// or https://");
          return this._restore(btn);
        }
        lively.identity.did._patchRelationships(function (state) {
          state.rssFeeds = state.rssFeeds || [];
          if (!state.rssFeeds.some(function (f) { return f.url === url; })) state.rssFeeds.push({ url: url });
        }, function (err) {
          if (err) { alert("Could not add feed: " + err.message); return self._restore(btn); }
          self._render();
        });
      },

      _removeFeed: function _removeFeed(url, btn) {
        var self = this;
        lively.identity.did._patchRelationships(function (state) {
          state.rssFeeds = (state.rssFeeds || []).filter(function (f) { return f.url !== url; });
        }, function (err) {
          if (err) { alert("Could not remove feed: " + err.message); return self._restore(btn); }
          self._render();
        });
      },
    });

    lively.identity.SettingsDialog = {
      // The base theme's title text (#555/#333) and focus ring are tuned for
      // light chrome; on this window's saturated pink frame they need a white
      // title and no ring. Scoped to one class so no other window changes
      // (same approach as DMChat.js's dm-accent-chrome).
      ensureAccentChromeCss: function () {
        var STYLE_ID = "settings-accent-chrome-style";
        if (document.getElementById(STYLE_ID)) return;
        var styleEl = document.createElement("style");
        styleEl.id = STYLE_ID;
        styleEl.textContent = [
          ".Window.settings-accent-chrome .Text.window-title { color: #fff; }",
          ".Window.settings-accent-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }",
          ".Window.settings-accent-chrome.highlighted { border: none !important; box-shadow: 0px 3px 10px rgba(90,0,40,0.35) !important; }",
        ].join("\n");
        document.head.appendChild(styleEl);
      },

      // A fresh passkey assertion over a fresh server challenge, for the signed-in
      // account's credential: { credentialId, authenticatorData, clientDataJSON,
      // signature, userHandle }. Calls thenDo(err, assertion). Call it only from a
      // user's click.
      freshAssertion: function (thenDo) {
        var did = lively.identity.did;
        var user = did.currentUser();
        fetch(did.baseUrl() + "/nodejs/IdentityServer/challenge", { credentials: "include" })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (body.error) throw new Error(body.error);
            // rpId must be the one the passkey was registered under (LoginDialog
            // passes the page hostname too); WebAuthn.authenticate's own fallback
            // is a configured identityRpId, which is not what this account used.
            lively.identity.webAuthn.authenticate({
              challenge: lively.identity.crypto.base64urlDecode(body.challenge),
              rpId: (user && user.rpId) || window.location.hostname,
              credentialIds: user && user.credentialId ? [user.credentialId] : [],
            }, thenDo);
          })
          .catch(function (err) { thenDo(err); });
      },

      open: function (tab, notice) {
        this.ensureAccentChromeCss();
        var win = lively.BuildSpec("lively.identity.SettingsDialog").createMorph();
        win.addStyleClassName("settings-accent-chrome");
        win.openInWorldCenter();
        win._notice = notice || null;
        win.load(tab);
        return win;
      },
    };

  });
