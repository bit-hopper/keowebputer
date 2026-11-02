/**
 * lively.identity.WorldsBrowser
 *
 * Floating window listing all worlds saved under the current user's identity.
 * Each row shows the entry's human-readable name, its web key (objId) followed
 * by a type label (World / Template · <key> / Wiki), and an "open" link
 * that navigates to /@handle/objId (or /@handle/wiki/<name> for a wiki page).
 * The search input filters by name (Enter to apply).
 * A "history" link drills into version history with per-version restore.
 *
 * A "Create" button opens a picker for three ways to make something new:
 *   - Blank world: a genuinely empty world under a chosen name. Built by
 *     fetching /blank.html (an already-proven, previously-saved empty world)
 *     and reusing its embedded <script type="text/x-lively-world"> JSON
 *     directly as the new envelope's record.payload — this sidesteps ever
 *     constructing/rendering a live World object (which would either miss
 *     internal setup World.createOn normally does, or clobber the live
 *     session's own $world if createOn were called directly).
 *   - Wiki page: a pure launcher into the existing NewWikiPageDialog/
 *     WikiEditor flow. Wiki pages save as type "wikipage", not "world", but
 *     are listed here too, labelled "Wiki".
 *   - Template: a single list of presets that pre-populate a new world
 *     (Shop/Inventory/Gallery/Books/Music are wired up; Movie/Game are
 *     inert "Coming soon" placeholders for now). A chosen template is launched
 *     into the fresh world via a one-time ?template= query param, handled by
 *     WorldTemplateLauncher.js after the redirect.
 *
 * Dependencies:
 *   lively.identity.DID — isLoggedIn, currentUser
 *   lively.identity.WebKey — generateGenesisObjId (objId minting for new worlds)
 *   lively.identity.SignedSerializer — serializeToEnvelope (envelope build + sign)
 */

module("lively.identity.WorldsBrowser")
  .requires(
    "lively.identity.DID",
    "lively.identity.WebKey",
    "lively.identity.SignedSerializer",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {
    lively.BuildSpec("lively.identity.WorldsBrowser", {
      _Extent: lively.pt(460, 400),
      _BorderRadius: 8,
      // Fill-frame/mat technique (see NewWikiPageDialog.js/ProfileCard.js):
      // the window's own fill shows through as a colored margin around the
      // gray content pane below and behind the title bar.
      _Fill: Color.rgb(0, 150, 136),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "WorldsBrowser",
      submorphs: [
        {
          _Extent: lively.pt(454, 375),
          _BorderColor: Color.rgb(95, 94, 95),
          _BorderRadius: 4,
          _Fill: Color.rgb(243, 243, 243),
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          layout: {
            adjustForNewBounds: true,
            resizeHeight: true,
            resizeWidth: true,
          },
          name: "worldsBrowserContent",
          submorphs: [],
        },
      ],

      // The base theme's default title-text color (#555) has too little contrast
      // against this window's teal _Fill, which shows through as the title bar's
      // own background (`.Window .TitleBar` is transparent by design). Scoped to
      // a shared class so it never affects any other window. Same technique, and
      // the same style element id, as AuthChoiceDialog.js / ProfileCard.js /
      // RegisterDialog.js, so whichever of them runs first installs it for all.
      _ensureAccentChromeCss: function () {
        var STYLE_ID = "identity-accent-chrome-style";
        if (document.getElementById(STYLE_ID)) return;
        var styleEl = document.createElement("style");
        styleEl.id = STYLE_ID;
        styleEl.textContent = [
          ".Window.identity-accent-chrome .Text.window-title { color: #fff; }",
          ".Window.identity-accent-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }",
        ].join("\n");
        document.head.appendChild(styleEl);
      },

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        this._ensureAccentChromeCss();
        this.addStyleClassName("identity-accent-chrome");
        this.targetMorph = this.get("worldsBrowserContent");
        var titleBar = this.makeTitleBar("My worlds", this.getExtent().x);
        this.titleBar = this.addMorph(titleBar);
        this.buildUI();
        this.loadWorlds();
      },

      buildUI: function buildUI() {
        var self = this;
        var content = this.get("worldsBrowserContent");
        if (!content) return;
        content.removeAllMorphs();

        var pad = 12;
        var w = content.getExtent().x - pad * 2;
        var y = pad;

        var createBtnW = 74;
        var searchW = w - createBtnW - 8;

        var searchInput = new lively.morphic.Text(lively.rect(pad, y, searchW, 26), "");
        searchInput.name = "searchInput";
        searchInput.applyStyle({
          allowInput: true,
          fontSize: 12,
          fill: Color.white,
          borderWidth: 1,
          borderColor: Color.rgb(190, 190, 190),
          borderRadius: 4,
          padding: lively.rect(26, 5, 0, 0),
        });
        searchInput.beInputLine();
        content.addMorph(searchInput);

        var searchIcon = new lively.morphic.Text(lively.rect(pad + 6, y + 5, 16, 16), "search");
        searchIcon.applyStyle({
          allowInput: false,
          fontFamily: "'Material Symbols Rounded'",
          fontSize: 12,
          textColor: Color.rgb(150, 150, 150),
          fill: null,
          borderWidth: 0,
          borderColor: null,
        });
        searchIcon.eventsAreIgnored = true;
        searchIcon.draggingEnabled = false;
        searchIcon.droppingEnabled = false;
        searchIcon.grabbingEnabled = false;
        content.addMorph(searchIcon);
        searchIcon.renderContext().shapeNode.style.pointerEvents = "none";

        var createBtn = new lively.morphic.Text(lively.rect(pad + searchW + 8, y, createBtnW, 26), "Create");
        createBtn.applyStyle({
          allowInput: false, fontSize: 13, fontWeight: "bold", textColor: Color.rgb(240, 26, 105),
          fill: Color.rgb(255, 240, 247), borderWidth: 1, borderColor: Color.rgb(240, 190, 210),
          borderRadius: 5,
        });
        createBtn.draggingEnabled = false;
        createBtn.droppingEnabled = false;
        createBtn.grabbingEnabled = false;
        createBtn.renderContext().shapeNode.style.cursor = "pointer";
        createBtn.onMouseOver = function () { createBtn.setFill(Color.rgb(255, 224, 238)); };
        createBtn.onMouseOut  = function () { createBtn.setFill(Color.rgb(255, 240, 247)); };
        createBtn.onMouseDown = function () {
          var win = lively.morphic.World.current().get("WorldsBrowser");
          if (win) win.showCreatePicker();
        };
        content.addMorph(createBtn);
        y += 34;

        var listH = content.getExtent().y - y - pad;
        var listBox = new lively.morphic.Box(lively.rect(pad, y, w, listH));
        listBox.name = "worldsList";
        listBox.applyStyle({
          fill: Color.white,
          clipMode: "auto",
          borderWidth: 1,
          borderColor: Color.rgb(220, 220, 220),
          borderRadius: 3,
        });
        content.addMorph(listBox);
        self.styleScrollList(listBox);

        lively.bindings.connect(searchInput, "savedTextString", self, "filterWorlds");
      },

      loadWorlds: function loadWorlds() {
        var self = this;
        var did = lively.identity.did;
        if (!did || !did.isLoggedIn()) {
          return self.showMessage("Sign in to view your worlds.");
        }
        var handle = did.currentUser().handle;
        self._handle = handle;
        self.showMessage("Loading...");

        fetch("/@" + handle, { credentials: "include", headers: { "Accept": "application/json" } })
          .then(function (r) { return r.json(); })
          .then(function (body) {
            var worlds = (body.objects || []).filter(function (e) {
              return e.type === "world" || e.type === "wikipage";
            });
            self._worlds = worlds;
            self.renderWorlds(worlds);
          })
          .catch(function (err) {
            self.showMessage("Could not load worlds: " + err.message);
          });
      },

      filterWorlds: function filterWorlds(query) {
        var self = this;
        var worlds = this._worlds || [];
        if (!query || !query.trim()) return this.renderWorlds(worlds);
        var q = query.trim().toLowerCase();
        this.renderWorlds(worlds.filter(function (e) {
          return self._entryName(e).toLowerCase().indexOf(q) !== -1;
        }));
      },

      // Display name for a list entry: worlds carry state.name; wiki pages
      // carry state.wikiName (the page's name, same one WikiIndex's cards
      // show) -- state.title is just the body's first line, often long or
      // empty, so it's only a fallback for pages with no wikiName.
      _entryName: function _entryName(e) {
        var s = e.state || {};
        return s.name || s.wikiName || s.title || e.objId;
      },

      // Type label shown after the web key: "Wiki", "Template · Shop" (a
      // world created from a template -- state.template is only recorded by
      // createWorld from now on, so older template worlds read as "World"),
      // or "World".
      _entryTypeLabel: function _entryTypeLabel(e) {
        if (e.type === "wikipage") return "Wiki";
        var t = e.state && e.state.template;
        if (t) return "Template · " + t.charAt(0).toUpperCase() + t.slice(1);
        return "World";
      },

      // Where "open" goes: a personal wiki page's friendly /wiki/<name> route
      // (same canonical URL WikiView's share link uses); everything else,
      // including constellation-scoped wiki pages, the generic objId route.
      _entryUrl: function _entryUrl(e, handle) {
        var wikiName = e.state && e.state.wikiName;
        if (e.type === "wikipage" && wikiName && !e.constellation) {
          return "/@" + handle + "/wiki/" + encodeURIComponent(wikiName);
        }
        return "/@" + handle + "/" + e.objId;
      },

      // Makes a clipped, vertically scrolling list box (the worlds list, the
      // history list, the create pickers) hold its rows without losing their
      // right-hand edge. A classic browser scrollbar takes ~15px out of the
      // box's inner width, and only once the list overflows, so rows built to the
      // box's outer width had their last ~15px (the "open" / "view →" links)
      // cut off by the overflow-x clip. This asks for a thin scrollbar and
      // reserves its space from the start (scrollbar-gutter: stable), so the inner
      // width is the same whether or not the list scrolls; pair it with
      // listInnerWidth() when sizing the rows. Call it right after the box has
      // been added to its owner (it styles the real DOM node). Not for a list
      // that should scroll horizontally.
      styleScrollList: function styleScrollList(listBox) {
        var s = listBox.renderContext().shapeNode.style;
        s.overflowX = "hidden";
        s.scrollbarWidth = "thin";
        s.scrollbarColor = "rgb(190, 190, 190) transparent";
        s.scrollbarGutter = "stable";
      },

      // The width rows should be built to: the list box's real inner width
      // (clientWidth: excludes its border and the reserved scrollbar gutter), not
      // its model extent. Call it after styleScrollList(). Falls back to the
      // model width minus a generous gutter + border if the node has no layout
      // yet (clientWidth is 0 for a node that is not in the document), so a row
      // never ends up wider than the visible area.
      listInnerWidth: function listInnerWidth(listBox) {
        var cw = listBox.renderContext().shapeNode.clientWidth;
        return cw > 0 ? cw : listBox.getExtent().x - 16;
      },

      showMessage: function showMessage(msg) {
        var listBox = this.get("worldsList");
        if (!listBox) return;
        listBox.removeAllMorphs();
        var w = listBox.getExtent().x;
        var t = new lively.morphic.Text(lively.rect(10, 10, w - 20, 20), msg);
        t.applyStyle({
          allowInput: false,
          fontSize: 11,
          textColor: Color.rgb(130, 130, 130),
          fill: null,
          borderWidth: 0,
          borderColor: null,
        });
        listBox.addMorph(t);
      },

      renderWorlds: function renderWorlds(worlds) {
        var self = this;
        var listBox = this.get("worldsList");
        if (!listBox) return;
        listBox.removeAllMorphs();

        if (!worlds || worlds.length === 0) {
          return self.showMessage("No worlds found.");
        }

        var handle = this._handle;
        // The inner width, not the box's outer one: the scrollbar's space is
        // already taken out (see styleScrollList).
        var w = this.listInnerWidth(listBox);
        var rowH = 52;
        var y = 4;
        var PINK       = Color.rgb(240, 26, 105);
        var PINK_HOVER = Color.rgb(190, 15, 82);
        var GRAY       = Color.rgb(150, 150, 150);
        var GRAY_HOVER = Color.rgb(90, 90, 90);
        var ROW_HOVER  = Color.rgb(224, 247, 244);

        worlds.forEach(function (envelope) {
          var name = self._entryName(envelope);
          var url  = self._entryUrl(envelope, handle);

          var row = new lively.morphic.Box(lively.rect(0, y, w, rowH));
          row.applyStyle({ fill: null, borderWidth: 0 });
          row.draggingEnabled = false;
          row.droppingEnabled = false;
          row.grabbingEnabled = false;
          row.onMouseOver = function () { row.setFill(ROW_HOVER); };
          row.onMouseOut  = function () { row.setFill(null); };

          var nameText = new lively.morphic.Text(lively.rect(10, 7, w - 130, 20), name);
          nameText.applyStyle({
            allowInput: false,
            fontSize: 13,
            fontWeight: "bold",
            textColor: Color.rgb(40, 40, 40),
            fill: null,
            borderWidth: 0,
            borderColor: null,
          });
          nameText.eventsAreIgnored = true;
          nameText.draggingEnabled = false;
          nameText.droppingEnabled = false;
          nameText.grabbingEnabled = false;
          row.addMorph(nameText);

          var keyText = new lively.morphic.Text(lively.rect(10, 29, w - 130, 14), envelope.objId + "  ·  " + self._entryTypeLabel(envelope));
          keyText.applyStyle({
            allowInput: false,
            fontSize: 10,
            textColor: Color.rgb(170, 170, 170),
            fill: null,
            borderWidth: 0,
            borderColor: null,
          });
          keyText.eventsAreIgnored = true;
          keyText.draggingEnabled = false;
          keyText.droppingEnabled = false;
          keyText.grabbingEnabled = false;
          row.addMorph(keyText);

          var historyLink = new lively.morphic.Text(lively.rect(w - 118, 16, 52, 18), "history");
          historyLink.applyStyle({
            allowInput: false,
            fontSize: 12,
            textColor: GRAY,
            fill: null,
            borderWidth: 0,
            borderColor: null,
          });
          historyLink.draggingEnabled = false;
          historyLink.droppingEnabled = false;
          historyLink.grabbingEnabled = false;
          historyLink.renderContext().shapeNode.style.cursor = "pointer";
          historyLink._objId      = envelope.objId;
          historyLink._worldName  = name;
          historyLink.onMouseOver = function () { historyLink.setTextColor(GRAY_HOVER); };
          historyLink.onMouseOut  = function () { historyLink.setTextColor(GRAY); };
          historyLink.onMouseDown = function () {
            var win = lively.morphic.World.current().get("WorldsBrowser");
            if (win) win.showHistory(this._objId, this._worldName);
          };
          row.addMorph(historyLink);

          var openLink = new lively.morphic.Text(lively.rect(w - 42, 16, 34, 18), "open");
          openLink.applyStyle({
            allowInput: false,
            fontSize: 12,
            textColor: PINK,
            fill: null,
            borderWidth: 0,
            borderColor: null,
          });
          openLink.draggingEnabled = false;
          openLink.droppingEnabled = false;
          openLink.grabbingEnabled = false;
          openLink.renderContext().shapeNode.style.cursor = "pointer";
          openLink._url = url;
          openLink.onMouseOver = function () { openLink.setTextColor(PINK_HOVER); };
          openLink.onMouseOut  = function () { openLink.setTextColor(PINK); };
          openLink.onMouseDown = function () { window.location.href = this._url; };
          row.addMorph(openLink);

          var sep = new lively.morphic.Box(lively.rect(10, rowH - 1, w - 20, 1));
          sep.applyStyle({ fill: Color.rgb(225, 225, 225), borderWidth: 0 });
          row.addMorph(sep);

          listBox.addMorph(row);
          y += rowH + 2;
        });
      },

      // ── history view ──────────────────────────────────────────────────────────

      showHistory: function showHistory(objId, worldName) {
        var self   = this;
        var handle = this._handle;
        self._renderHistoryUI(objId, worldName, null); // show loading state
        fetch("/@" + handle + "/" + objId + "/versions", { credentials: "include", headers: { "Accept": "application/json" } })
          .then(function (r) { return r.json(); })
          .then(function (body) {
            self._renderHistoryUI(objId, worldName, body.versions || []);
          })
          .catch(function (err) {
            self._renderHistoryUI(objId, worldName, null, "Could not load versions: " + err.message);
          });
      },

      _renderHistoryUI: function _renderHistoryUI(objId, worldName, versions, errorMsg) {
        var content = this.get("worldsBrowserContent");
        if (!content) return;
        content.removeAllMorphs();

        var pad  = 12;
        var cw   = content.getExtent().x;
        var w    = cw - pad * 2;
        var y    = pad;
        var PINK = Color.rgb(240, 26, 105);
        var GRAY = Color.rgb(140, 140, 140);

        var PINK_HOVER = Color.rgb(190, 15, 82);

        // back link
        var backLink = new lively.morphic.Text(lively.rect(pad, y, 110, 18), "← My worlds");
        backLink.applyStyle({ allowInput: false, fontSize: 12, textColor: PINK, fill: null, borderWidth: 0, borderColor: null });
        backLink.draggingEnabled = false;
        backLink.droppingEnabled = false;
        backLink.grabbingEnabled = false;
        backLink.renderContext().shapeNode.style.cursor = "pointer";
        backLink.onMouseOver = function () { backLink.setTextColor(PINK_HOVER); };
        backLink.onMouseOut  = function () { backLink.setTextColor(PINK); };
        backLink.onMouseDown = function () {
          var win = lively.morphic.World.current().get("WorldsBrowser");
          if (win) win.showWorlds();
        };
        content.addMorph(backLink);

        // world name header
        var header = new lively.morphic.Text(lively.rect(pad + 118, y, w - 118, 18), worldName || objId);
        header.applyStyle({ allowInput: false, fontSize: 13, fontWeight: "bold",
          textColor: Color.rgb(40, 40, 40), fill: null, borderWidth: 0, borderColor: null });
        content.addMorph(header);
        y += 28;

        // divider
        var div = new lively.morphic.Box(lively.rect(pad, y, w, 1));
        div.applyStyle({ fill: Color.rgb(220, 220, 220), borderWidth: 0 });
        content.addMorph(div);
        y += 10;

        if (errorMsg) {
          var errT = new lively.morphic.Text(lively.rect(pad, y, w, 20), errorMsg);
          errT.applyStyle({ allowInput: false, fontSize: 11, textColor: GRAY, fill: null, borderWidth: 0, borderColor: null });
          content.addMorph(errT);
          return;
        }

        if (!versions) {
          var loading = new lively.morphic.Text(lively.rect(pad, y, w, 20), "Loading...");
          loading.applyStyle({ allowInput: false, fontSize: 11, textColor: GRAY, fill: null, borderWidth: 0, borderColor: null });
          content.addMorph(loading);
          return;
        }

        if (versions.length === 0) {
          var none = new lively.morphic.Text(lively.rect(pad, y, w, 20), "No version history found.");
          none.applyStyle({ allowInput: false, fontSize: 11, textColor: GRAY, fill: null, borderWidth: 0, borderColor: null });
          content.addMorph(none);
          return;
        }

        // versions newest-first; index 0 = current
        var ordered = versions.slice().reverse();
        var handle  = this._handle;

        var listBox = new lively.morphic.Box(lively.rect(pad, y, w, content.getExtent().y - y - pad));
        listBox.applyStyle({ fill: Color.white, clipMode: "auto",
          borderWidth: 1, borderColor: Color.rgb(220, 220, 220), borderRadius: 3 });
        content.addMorph(listBox);
        this.styleScrollList(listBox);
        // Rows from here on are built to the list's inner width (the header above
        // already used the content width).
        w = this.listInnerWidth(listBox);

        var rowH = 46;
        var ry   = 4;

        ordered.forEach(function (v, idx) {
          var isCurrent = idx === 0;

          var date = "—";
          try {
            var d = new Date(v.createdAt);
            date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
              + "  " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
          } catch (e) { date = v.createdAt || "—"; }

          var cidShort = v.cid ? v.cid.slice(0, 10) + "…" : "—";

          var row = new lively.morphic.Box(lively.rect(0, ry, w, rowH));
          row.applyStyle({ fill: null, borderWidth: 0 });
          row.draggingEnabled = false;
          row.droppingEnabled = false;
          row.grabbingEnabled = false;
          row.onMouseOver = function () { row.setFill(Color.rgb(224, 247, 244)); };
          row.onMouseOut  = function () { row.setFill(null); };

          var dateT = new lively.morphic.Text(lively.rect(10, 6, w - 160, 18), date);
          dateT.applyStyle({ allowInput: false, fontSize: 12,
            fontWeight: isCurrent ? "bold" : "normal",
            textColor: Color.rgb(40, 40, 40), fill: null, borderWidth: 0, borderColor: null });
          dateT.eventsAreIgnored = true;
          dateT.draggingEnabled = false;
          dateT.droppingEnabled = false;
          dateT.grabbingEnabled = false;
          row.addMorph(dateT);

          var cidT = new lively.morphic.Text(lively.rect(10, 26, w - 160, 14), cidShort);
          cidT.applyStyle({ allowInput: false, fontSize: 10, textColor: GRAY, fill: null, borderWidth: 0, borderColor: null });
          cidT.eventsAreIgnored = true;
          cidT.draggingEnabled = false;
          cidT.droppingEnabled = false;
          cidT.grabbingEnabled = false;
          row.addMorph(cidT);

          if (isCurrent) {
            var curLabel = new lively.morphic.Text(lively.rect(w - 148, 13, 60, 18), "current");
            curLabel.applyStyle({ allowInput: false, fontSize: 11, textColor: GRAY, fill: null, borderWidth: 0, borderColor: null });
            curLabel.eventsAreIgnored = true;
            curLabel.draggingEnabled = false;
            curLabel.droppingEnabled = false;
            curLabel.grabbingEnabled = false;
            row.addMorph(curLabel);
          } else {
            // view — non-destructive, opens the snapshot and lets you navigate back
            var viewLink = new lively.morphic.Text(lively.rect(w - 70, 13, 60, 18), "view →");
            viewLink.applyStyle({ allowInput: false, fontSize: 12, textColor: PINK, fill: null, borderWidth: 0, borderColor: null });
            viewLink.draggingEnabled = false;
            viewLink.droppingEnabled = false;
            viewLink.grabbingEnabled = false;
            viewLink.renderContext().shapeNode.style.cursor = "pointer";
            viewLink._vUrl = "/@" + handle + "/" + objId + "/at/" + encodeURIComponent(v.cid);
            viewLink.onMouseOver = function () { viewLink.setTextColor(PINK_HOVER); };
            viewLink.onMouseOut  = function () { viewLink.setTextColor(PINK); };
            viewLink.onMouseDown = function () { window.location.href = this._vUrl; };
            row.addMorph(viewLink);
          }

          var sep = new lively.morphic.Box(lively.rect(10, rowH - 1, w - 20, 1));
          sep.applyStyle({ fill: Color.rgb(225, 225, 225), borderWidth: 0 });
          row.addMorph(sep);

          listBox.addMorph(row);
          ry += rowH + 2;
        });
      },

      showWorlds: function showWorlds() {
        this.buildUI();
        this.loadWorlds();
      },

      // ── create flow ─────────────────────────────────────────────────────────

      // Shared row builder for the create-picker's 3 top-level cards and the
      // template list's items — a spec-level method (this._buildCreateCardRow),
      // not a free function in the enclosing .toRun() closure, since BuildSpec
      // method bodies are eval'd independently and don't share that closure
      // (see this file's other methods / ConstellationsBrowser.js's header note
      // for the same discipline).
      _buildCreateCardRow: function _buildCreateCardRow(w, rowH, iconName, title, subtitle, enabled, tagText) {
        var TEAL = Color.rgb(0, 150, 136);
        var GRAY = Color.rgb(160, 160, 160);
        var DARK = Color.rgb(40, 40, 40);
        var HOVER = Color.rgb(224, 247, 244);

        var row = new lively.morphic.Box(lively.rect(0, 0, w, rowH));
        row.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: Color.rgb(228, 228, 228), borderRadius: 6 });
        row.draggingEnabled = false;
        row.droppingEnabled = false;
        row.grabbingEnabled = false;
        if (enabled) {
          row.renderContext().shapeNode.style.cursor = "pointer";
          row.onMouseOver = function () { row.setFill(HOVER); };
          row.onMouseOut  = function () { row.setFill(Color.white); };
        } else {
          row.renderContext().shapeNode.title = "Coming soon — not available yet";
        }

        var icon = new lively.morphic.Text(lively.rect(16, (rowH - 24) / 2, 24, 24), iconName);
        icon.applyStyle({
          allowInput: false, fontFamily: "'Material Symbols Rounded'", fontSize: 18,
          textColor: enabled ? TEAL : GRAY, fill: null, borderWidth: 0, borderColor: null,
        });
        icon.eventsAreIgnored = true;
        icon.draggingEnabled = false;
        icon.droppingEnabled = false;
        icon.grabbingEnabled = false;
        row.addMorph(icon);

        var textW = tagText ? w - 60 - 100 : w - 60;

        var titleT = new lively.morphic.Text(lively.rect(52, 12, textW, 18), title);
        titleT.applyStyle({
          allowInput: false, fontSize: 13, fontWeight: "bold",
          textColor: enabled ? DARK : GRAY, fill: null, borderWidth: 0, borderColor: null,
        });
        titleT.eventsAreIgnored = true;
        titleT.draggingEnabled = false;
        titleT.droppingEnabled = false;
        titleT.grabbingEnabled = false;
        row.addMorph(titleT);

        var subT = new lively.morphic.Text(lively.rect(52, 32, textW, 16), subtitle);
        subT.applyStyle({ allowInput: false, fontSize: 11, textColor: GRAY, fill: null, borderWidth: 0, borderColor: null });
        subT.eventsAreIgnored = true;
        subT.draggingEnabled = false;
        subT.droppingEnabled = false;
        subT.grabbingEnabled = false;
        row.addMorph(subT);

        if (tagText) {
          var tag = new lively.morphic.Text(lively.rect(w - 106, (rowH - 20) / 2, 92, 20), tagText);
          tag.applyStyle({
            allowInput: false, fontSize: 10, textColor: Color.rgb(150, 150, 150),
            fill: Color.rgb(238, 238, 238), borderWidth: 1, borderColor: Color.rgb(220, 220, 220),
            borderRadius: 4,
          });
          tag.eventsAreIgnored = true;
          tag.draggingEnabled = false;
          tag.droppingEnabled = false;
          tag.grabbingEnabled = false;
          row.addMorph(tag);
        }

        return row;
      },

      showCreatePicker: function showCreatePicker() {
        var self = this;
        var content = this.get("worldsBrowserContent");
        if (!content) return;
        content.removeAllMorphs();

        var pad = 12;
        var w = content.getExtent().x - pad * 2;
        var y = pad;
        var PINK       = Color.rgb(240, 26, 105);
        var PINK_HOVER = Color.rgb(190, 15, 82);

        var backLink = new lively.morphic.Text(lively.rect(pad, y, 110, 18), "← My worlds");
        backLink.applyStyle({ allowInput: false, fontSize: 12, textColor: PINK, fill: null, borderWidth: 0, borderColor: null });
        backLink.draggingEnabled = false;
        backLink.droppingEnabled = false;
        backLink.grabbingEnabled = false;
        backLink.renderContext().shapeNode.style.cursor = "pointer";
        backLink.onMouseOver = function () { backLink.setTextColor(PINK_HOVER); };
        backLink.onMouseOut  = function () { backLink.setTextColor(PINK); };
        backLink.onMouseDown = function () {
          var win = lively.morphic.World.current().get("WorldsBrowser");
          if (win) win.showWorlds();
        };
        content.addMorph(backLink);
        y += 28;

        var header = new lively.morphic.Text(lively.rect(pad, y, w, 18), "Create new");
        header.applyStyle({ allowInput: false, fontSize: 13, fontWeight: "bold", textColor: Color.rgb(40, 40, 40), fill: null, borderWidth: 0, borderColor: null });
        content.addMorph(header);
        y += 26;

        var div = new lively.morphic.Box(lively.rect(pad, y, w, 1));
        div.applyStyle({ fill: Color.rgb(220, 220, 220), borderWidth: 0 });
        content.addMorph(div);
        y += 10;

        // Scrollable container for the cards, same idiom as the worlds list
        // / version-history list elsewhere in this file -- a fixed content
        // pane can't just keep growing to fit however many cards there are,
        // so cards go in their own clipped, independently-scrolling box
        // rather than straight into `content` (confirmed live: without
        // this, the template list's 6 rows ran ~80px past the window's own
        // bottom edge with nothing to clip or scroll them).
        var listH = content.getExtent().y - y - pad;
        var listBox = new lively.morphic.Box(lively.rect(pad, y, w, listH));
        listBox.applyStyle({ fill: null, clipMode: "auto", borderWidth: 0 });
        content.addMorph(listBox);
        self.styleScrollList(listBox);
        w = self.listInnerWidth(listBox);

        var cards = [
          { icon: "note_add",            title: "Blank world", subtitle: "Start with a completely empty world.", action: "blank" },
          { icon: "article",             title: "Wiki page",   subtitle: "Create a wiki page for your profile.", action: "wiki" },
          { icon: "dashboard_customize", title: "Template",    subtitle: "Start from a preset like Shop.",       action: "template" },
        ];

        var rowH = 62;
        var ry = 0;
        cards.forEach(function (card) {
          var row = self._buildCreateCardRow(w, rowH, card.icon, card.title, card.subtitle, true, null);
          row.onMouseDown = function () {
            var win = lively.morphic.World.current().get("WorldsBrowser");
            if (!win) return;
            if (card.action === "blank") win.showCreateForm(null);
            else if (card.action === "wiki") win.launchWikiCreation();
            else if (card.action === "template") win.showCreateTemplateList();
          };
          row.setPosition(lively.pt(0, ry));
          listBox.addMorph(row);
          ry += rowH + 6;
        });
      },

      launchWikiCreation: function launchWikiCreation() {
        var user = lively.identity.did.currentUser();
        if (!user) return;
        // Wikis live on their own route, not inside whichever world this
        // browser happens to be open in: hand off to the wiki index, which
        // shows the new-page dialog and hosts the editor there
        // (WikiIndex.js's "?new=1" handling).
        // Mirrors "Blank world"/"Template"'s own redirect below -- without
        // this, navigating away from the CURRENT world triggers a real
        // "leave site?" beforeunload confirm that blocks the redirect until
        // a human dismisses it.
        if (lively.Config) lively.Config.askBeforeQuit = false;
        window.location.href = "/@" + encodeURIComponent(user.handle) + "/wiki?new=1";
      },

      showCreateTemplateList: function showCreateTemplateList() {
        var self = this;
        var content = this.get("worldsBrowserContent");
        if (!content) return;
        content.removeAllMorphs();

        var pad = 12;
        var w = content.getExtent().x - pad * 2;
        var y = pad;
        var PINK       = Color.rgb(240, 26, 105);
        var PINK_HOVER = Color.rgb(190, 15, 82);

        var backLink = new lively.morphic.Text(lively.rect(pad, y, 70, 18), "← Back");
        backLink.applyStyle({ allowInput: false, fontSize: 12, textColor: PINK, fill: null, borderWidth: 0, borderColor: null });
        backLink.draggingEnabled = false;
        backLink.droppingEnabled = false;
        backLink.grabbingEnabled = false;
        backLink.renderContext().shapeNode.style.cursor = "pointer";
        backLink.onMouseOver = function () { backLink.setTextColor(PINK_HOVER); };
        backLink.onMouseOut  = function () { backLink.setTextColor(PINK); };
        backLink.onMouseDown = function () {
          var win = lively.morphic.World.current().get("WorldsBrowser");
          if (win) win.showCreatePicker();
        };
        content.addMorph(backLink);
        y += 28;

        var header = new lively.morphic.Text(lively.rect(pad, y, w, 18), "Choose a template");
        header.applyStyle({ allowInput: false, fontSize: 13, fontWeight: "bold", textColor: Color.rgb(40, 40, 40), fill: null, borderWidth: 0, borderColor: null });
        content.addMorph(header);
        y += 26;

        var div = new lively.morphic.Box(lively.rect(pad, y, w, 1));
        div.applyStyle({ fill: Color.rgb(220, 220, 220), borderWidth: 0 });
        content.addMorph(div);
        y += 10;

        // Scrollable container, same reasoning as showCreatePicker's own --
        // this list has grown past what the fixed content pane can show
        // without clipping/scrolling (confirmed live: 6 rows ran ~80px past
        // the window's bottom edge when added straight to `content`).
        var listH = content.getExtent().y - y - pad;
        var listBox = new lively.morphic.Box(lively.rect(pad, y, w, listH));
        listBox.applyStyle({ fill: null, clipMode: "auto", borderWidth: 0 });
        content.addMorph(listBox);
        self.styleScrollList(listBox);
        w = self.listInnerWidth(listBox);

        var templates = [
          { icon: "storefront",     title: "Shop",                   subtitle: "A storefront to sell items.",              enabled: true,  key: "shop" },
          { icon: "inventory_2",    title: "Import from Inventory",  subtitle: "Browse your parts and drag one in.",       enabled: true,  key: "inventory" },
          { icon: "photo_library",  title: "Gallery",                subtitle: "Organize and display photos.",             enabled: true,  key: "gallery" },
          { icon: "movie",          title: "Movie",                  subtitle: "Organize your favorite movies.",           enabled: false, key: "movie" },
          { icon: "menu_book",      title: "Books",                  subtitle: "Organize your book collection.",           enabled: true,  key: "books" },
          { icon: "sports_esports", title: "Game",                   subtitle: "Organize your video games.",               enabled: true,  key: "game" },
          { icon: "library_music",  title: "Music",                  subtitle: "Organize your music collection.",          enabled: true,  key: "music" },
          { icon: "edit_note",      title: "Diary",                  subtitle: "Keep a private diary.",                    enabled: true,  key: "diary" },
        ];

        var rowH = 58;
        var ry = 0;
        templates.forEach(function (t) {
          var row = self._buildCreateCardRow(w, rowH, t.icon, t.title, t.subtitle, t.enabled, t.enabled ? null : "Coming soon");
          if (t.enabled) {
            row.onMouseDown = function () {
              var win = lively.morphic.World.current().get("WorldsBrowser");
              if (win) win.showCreateForm(t.key);
            };
          }
          row.setPosition(lively.pt(0, ry));
          listBox.addMorph(row);
          ry += rowH + 6;
        });
      },

      showCreateForm: function showCreateForm(template) {
        var content = this.get("worldsBrowserContent");
        if (!content) return;
        content.removeAllMorphs();

        var pad = 12;
        var w = content.getExtent().x - pad * 2;
        var y = pad;
        var PINK       = Color.rgb(240, 26, 105);
        var PINK_HOVER = Color.rgb(190, 15, 82);
        var GRAY       = Color.rgb(140, 140, 140);

        var backLink = new lively.morphic.Text(lively.rect(pad, y, 70, 18), "← Back");
        backLink.applyStyle({ allowInput: false, fontSize: 12, textColor: PINK, fill: null, borderWidth: 0, borderColor: null });
        backLink.draggingEnabled = false;
        backLink.droppingEnabled = false;
        backLink.grabbingEnabled = false;
        backLink.renderContext().shapeNode.style.cursor = "pointer";
        backLink.onMouseOver = function () { backLink.setTextColor(PINK_HOVER); };
        backLink.onMouseOut  = function () { backLink.setTextColor(PINK); };
        backLink.onMouseDown = function () {
          var win = lively.morphic.World.current().get("WorldsBrowser");
          if (!win) return;
          if (template) win.showCreateTemplateList();
          else win.showCreatePicker();
        };
        content.addMorph(backLink);
        y += 28;

        var titleStr = template === "shop" ? "New Shop world"
          : template === "inventory" ? "New world with Inventory"
          : template === "diary" ? "New Diary world"
          : template === "game" ? "New Game world"
          : "New blank world";
        var header = new lively.morphic.Text(lively.rect(pad, y, w, 18), titleStr);
        header.applyStyle({ allowInput: false, fontSize: 13, fontWeight: "bold", textColor: Color.rgb(40, 40, 40), fill: null, borderWidth: 0, borderColor: null });
        content.addMorph(header);
        y += 30;

        var label = new lively.morphic.Text(lively.rect(pad, y, w, 16), "Name");
        label.applyStyle({ allowInput: false, fontFamily: "Arial, sans-serif", fontSize: 11, textColor: GRAY, fill: null, borderWidth: 0, borderColor: null });
        content.addMorph(label);
        y += 20;

        var nameInput = new lively.morphic.Text(lively.rect(pad, y, w, 26), "");
        nameInput.name = "createNameInput";
        nameInput.applyStyle({
          allowInput: true, fontSize: 12, fill: Color.white, borderWidth: 1,
          borderColor: Color.rgb(190, 190, 190), borderRadius: 4, padding: lively.rect(6, 5, 0, 0),
        });
        nameInput.beInputLine();
        content.addMorph(nameInput);
        this._createNameInput = nameInput;
        y += 36;

        var createBtn = new lively.morphic.Text(lively.rect(pad, y, 90, 26), "Create");
        createBtn.applyStyle({
          allowInput: false, fontSize: 13, fontWeight: "bold", textColor: PINK,
          fill: Color.rgb(255, 240, 247), borderWidth: 1, borderColor: Color.rgb(240, 190, 210),
          borderRadius: 5,
        });
        createBtn.draggingEnabled = false;
        createBtn.droppingEnabled = false;
        createBtn.grabbingEnabled = false;
        createBtn.renderContext().shapeNode.style.cursor = "pointer";
        createBtn.onMouseOver = function () { createBtn.setFill(Color.rgb(255, 224, 238)); };
        createBtn.onMouseOut  = function () { createBtn.setFill(Color.rgb(255, 240, 247)); };
        createBtn.onMouseDown = function () {
          var win = lively.morphic.World.current().get("WorldsBrowser");
          if (win) win.submitCreate(template);
        };
        content.addMorph(createBtn);

        var statusText = new lively.morphic.Text(lively.rect(pad + 100, y + 4, w - 100, 18), "");
        statusText.applyStyle({ allowInput: false, fontSize: 11, textColor: GRAY, fill: null, borderWidth: 0, borderColor: null });
        content.addMorph(statusText);
        this._createStatusText = statusText;
      },

      setCreateStatus: function setCreateStatus(msg, isError) {
        if (!this._createStatusText) return;
        this._createStatusText.setTextString(msg || "");
        this._createStatusText.setTextColor(isError ? Color.rgb(200, 50, 50) : Color.rgb(140, 140, 140));
      },

      submitCreate: function submitCreate(template) {
        var name = ((this._createNameInput && this._createNameInput.textString) || "").trim();
        if (!name) return this.setCreateStatus("Enter a name first.", true);
        this.setCreateStatus("Fetching template…");
        this.createWorld(name, template);
      },

      // Fetches blank.html's already-serialized empty-world JSO and reuses it
      // directly as the new envelope's record.payload -- see this file's
      // header comment for why (no live World construction/rendering needed).
      createWorld: function createWorld(name, template) {
        var self = this;
        var did = lively.identity.did;
        var user = did.currentUser();
        if (!user) return self.setCreateStatus("Sign in required.", true);

        fetch("/blank.html")
          .then(function (r) { return r.text(); })
          .then(function (html) {
            var m = html.match(/<script[^>]*type="text\/x-lively-world"[^>]*>([\s\S]*?)<\/script>/);
            if (!m) throw new Error("blank world template not found");
            var jso = JSON.parse(m[1]);

            // Scrub stale dev-machine bookkeeping baked into blank.html's own
            // last save (a local filesystem user id + working directories) --
            // cosmetic only, not required for the world to load.
            var rootObj = jso.registry && jso.registry[jso.id];
            if (rootObj) {
              delete rootObj.currentUser;
              delete rootObj.knownWorkingDirectories;
            }

            self.setCreateStatus("Generating…");
            lively.identity.webKey.generateGenesisObjId(user.did, function (err, gen) {
              if (err) return self.setCreateStatus("Error: " + err.message, true);

              var method = did.findMethodByCredentialId(user.document, user.credentialId);

              self.setCreateStatus("Signing… (confirm your passkey if prompted)");
              lively.identity.signedSerializer.serializeToEnvelope({
                jso: jso,
                type: "world",
                objId: gen.objId,
                genesisNonce: gen.genesisNonce,
                publicKeyJwk: method ? method.publicKeyJwk : null,
                stateMeta: template ? { name: name, template: template } : { name: name },
              }, function (err, envelope) {
                if (err) return self.setCreateStatus("Error: " + err.message, true);

                self.setCreateStatus("Creating…");
                fetch("/@" + user.handle + "/" + gen.objId, {
                  method: "PUT",
                  credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(envelope),
                })
                  .then(function (r) { return r.json(); })
                  .then(function (body) {
                    if (!body.ok) return self.setCreateStatus("Create failed: " + (body.error || "?"), true);
                    self.setCreateStatus("Created — opening…");
                    // Without this, navigating away from the CURRENT world
                    // triggers a real "leave site?" beforeunload confirm
                    // (askBeforeQuit) that blocks the redirect until a human
                    // dismisses it -- confirmed live. Widgets.js's own
                    // "Save world as..."/"Save world" do the same before
                    // their redirect.
                    if (lively.Config) lively.Config.askBeforeQuit = false;
                    var url = "/@" + user.handle + "/" + gen.objId;
                    if (template) url += "?template=" + encodeURIComponent(template);
                    window.location.href = url;
                  })
                  .catch(function (e) { self.setCreateStatus("Create failed: " + e.message, true); });
              });
            });
          })
          .catch(function (err) { self.setCreateStatus("Could not create world: " + err.message, true); });
      },
    });
  }); // end module('lively.identity.WorldsBrowser')
