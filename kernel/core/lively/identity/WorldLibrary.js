/**
 * lively.identity.WorldLibrary
 *
 * Window listing the worlds saved on this device by the signed-in identity, inside keo only (the shell keeps them, encrypted,
 * shell/keo-worlds.js). A person can search them (by name, tag, note and the words written inside), open one, start a new named
 * world, rename, copy, tag and delete. Nothing here sees a key or a stored document: the shell does the searching and hands back
 * names, tags and short snippets.
 *
 * Not lively.identity.WorldsDialog, which is the homestar's "featured worlds" chooser and talks to a host.
 *
 * The window is built once and its pieces are kept: only the list of rows is drawn again, so the search field keeps focus and its
 * text while the results change. Every answer carries the number of the request that asked for it; one that is no longer the
 * latest (the person typed on) is dropped.
 *
 * Async convention: thenDo(err, result) throughout (LocalIdentity).
 *
 * Dependencies:
 *   lively.identity.LocalIdentity — the shell calls
 *   lively.identity.HomestarUI    — scroller (the thin scrollbar)
 */

module("lively.identity.WorldLibrary")
  .requires(
    "lively.identity.LocalIdentity",
    "lively.identity.HomestarUI",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete"
  )
  .toRun(function () {
    lively.BuildSpec("lively.identity.WorldLibrary", {
      _BorderRadius: 7,
      _Extent: lively.pt(540, 300),
      _Fill: Color.rgb(255, 16, 144),
      _ZIndex: 1000,
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "IdentityWorldLibrary",
      titleBar: "Worlds",
      submorphs: [
        {
          _Extent: lively.pt(534, 272),
          _Fill: Color.rgb(250, 250, 250),
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          layout: {
            adjustForNewBounds: true,
            resizeHeight: true,
            resizeWidth: true,
          },
          name: "worldsContent",
          submorphs: [],
        },
      ],

      // ─── lifecycle ──────────────────────────────────────────────────────────────

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        $super();
        var self = this;
        this._ensureAccentChromeCss();
        this.addStyleClassName("identity-accent-chrome");
        this._d = { q: "", items: null, sel: null, seq: 0, skipped: 0, status: null, clickedAt: 0, clickedName: null };
        this.build();
        // the library changed somewhere else (the world's own save, another copy of this window): read it again
        this._onChanged = function () { if (self.world()) self.load(); };
        window.addEventListener("keo-worlds-changed", this._onChanged);
        this.load();
      },

      remove: function remove() {
        if (this._onChanged) window.removeEventListener("keo-worlds-changed", this._onChanged);
        this._onChanged = null;
        clearTimeout(this._debounce);
        if (this._d) this._d.seq++;
        $super();
      },

      // The title bar text is white on the accent colour (the same rule PeerDialog and FriendsDialog add).
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

      // ─── drawing: the parts that stay ───────────────────────────────────────────

      build: function build() {
        var self = this, content = this.get("worldsContent");
        content.removeAllMorphs();
        var pad = 14, W = 534, w = W - pad * 2, y = 10, ROWS = 7, ROW_H = 52, LIST_H = ROWS * ROW_H;

        function text(str, x, yy, tw, h, opts) {
          opts = opts || {};
          var t = new lively.morphic.Text(lively.rect(x, yy, tw, h), str);
          t.applyStyle({
            allowInput: !!opts.input,
            fontFamily: "Arial, sans-serif",
            fontSize: opts.size || 9,   // points: 9 is about 12 px
            textColor: opts.color || Color.rgb(70, 70, 70),
            padding: lively.rect(4, 3, 0, 0),
            fill: opts.input ? Color.white : null,
            borderWidth: opts.input ? 1 : 0,
            borderColor: opts.input ? Color.rgb(203, 203, 203) : null,
            borderRadius: opts.input ? 3.75 : 0,
            fixedWidth: true,
            fixedHeight: true,
            clipMode: "hidden",
          });
          if (opts.name) t.name = opts.name;
          content.addMorph(t);
          return t;
        }
        function paintButton(btn, borderColor, borderWidth, borderRadius, fill) {
          btn.applyStyle({ borderColor: borderColor, borderWidth: borderWidth, borderRadius: borderRadius, fill: fill });
          (function () {
            var node = btn.renderContext && btn.renderContext().shapeNode;
            if (node) {
              node.style.borderColor = borderColor;
              node.style.borderWidth = borderWidth + "px";
              node.style.borderRadius = borderRadius + "px";
              node.style.background = fill || "";
            }
          }).delay(0);
        }
        function button(str, name, x, bw, kind, method) {
          var b = new lively.morphic.Button(lively.rect(x, y, bw, 24), str);
          b.name = name;
          content.addMorph(b);
          if (kind === "main") paintButton(b, "rgb(240,190,210)", 1.184, 5.2, "rgb(255,240,247)");
          else paintButton(b, "rgb(214,214,214)", 1, 5, null);
          lively.bindings.connect(b, "fire", self, method);
          return b;
        }

        if (!lively.identity.localIdentity.isAvailable()) {
          text("Saved worlds need keo webputer.", pad, y, w, 20);
          return;
        }

        text("Find a world by its name, its tags, or words written in it.", pad, y, w, 20, { name: "hintText", size: 9 });
        y += 22;
        var input = text("", pad, y, w, 26, { input: true, size: 10, name: "searchInput" });
        input.beInputLine();
        // The DOM's own `input` event, read from the field's text: a Text morph's onKeyUp can miss keys typed straight after the
        // window opens (the runtime's CLAUDE.md, "a morph's onKeyUp can miss keys typed right after opening").
        var node = input.renderContext().shapeNode;
        node.addEventListener("input", function () { self.setQuery(node.textContent); });
        // The browser's own focus ring (a black box) is replaced by the accent colour on the field's border.
        if (!document.getElementById("world-library-style")) {
          var st = document.createElement("style");
          st.id = "world-library-style";
          st.textContent = ".world-library-input, .world-library-input * { outline: none !important; }";
          document.head.appendChild(st);
        }
        node.classList.add("world-library-input");
        node.addEventListener("focusin", function () { node.style.borderColor = "rgb(240,26,105)"; });
        node.addEventListener("focusout", function () { node.style.borderColor = "rgb(203,203,203)"; });
        y += 34;

        var list = new lively.morphic.Box(lively.rect(pad, y, w, LIST_H));
        list.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: Color.rgb(222, 222, 228), borderRadius: 4, clipMode: "auto" });
        list.name = "worldsList";
        list.draggingEnabled = false; list.grabbingEnabled = false; list.droppingEnabled = false;
        content.addMorph(list);
        lively.identity.HomestarUI.scroller(list);
        this._rows = { h: ROW_H, w: w - 2 };
        y += LIST_H + 10;

        button("Open", "openBtn", pad, 70, "main", "onOpen");
        button("New world…", "newBtn", pad + 76, 96, "plain", "onNew");
        button("Rename…", "renameBtn", pad + 178, 78, "plain", "onRename");
        button("Tags & note…", "metaBtn", pad + 262, 100, "plain", "onMeta");
        button("Copy…", "copyBtn", pad + 368, 66, "plain", "onCopy");
        button("Delete", "deleteBtn", pad + 440, 66, "plain", "onDelete");
        y += 32;

        text("", pad, y, w, 34, { name: "statusText", size: 8, color: Color.rgb(153, 153, 153) });
        y += 38;

        var contentH = y + 4;
        this.setExtent(lively.pt(W + 6, contentH + 28));
        content.setExtent(lively.pt(W, contentH));
        this.renderList();
      },

      // ─── data ───────────────────────────────────────────────────────────────────

      setQuery: function setQuery(q) {
        var self = this;
        this._d.q = String(q == null ? "" : q);
        clearTimeout(this._debounce);
        // A search opens every world's text, so it is not asked for at each key; the answer to an older question is dropped.
        this._debounce = setTimeout(function () { if (self.world()) self.load(); }, 150);
      },

      load: function load() {
        var self = this, d = this._d, li = lively.identity.localIdentity;
        if (!d || !li.isAvailable()) return;
        var seq = ++d.seq, q = d.q.trim();
        function done(err, items, skipped) {
          if (seq !== d.seq || !self.world()) return;
          if (err) { d.items = []; self.setStatus("Could not read your worlds: " + (err.message || err), true); }
          else {
            d.items = items || [];
            d.skipped = skipped || 0;
            self.setStatus(d.skipped ? d.skipped + (d.skipped === 1 ? " world" : " worlds") + " could not be read for the search." : "");
          }
          if (d.sel && !d.items.some(function (it) { return it.name === d.sel; })) d.sel = null;
          self.renderList();
        }
        if (q) li.worldSearch(q, function (err, r) { done(err, r && r.hits, r && r.skipped); });
        else li.worldList(function (err, l) { done(err, l, 0); });
      },

      // ─── drawing: the list ──────────────────────────────────────────────────────

      renderList: function renderList() {
        var self = this, list = this.get("worldsList"), d = this._d;
        if (!list || !d) return;
        list.removeAllMorphs();
        var R = this._rows, W = R.w, ROW_H = R.h, INK = Color.rgb(42, 36, 56), MUTED = Color.rgb(122, 115, 144);

        function ago(iso) {
          var s = (Date.now() - Date.parse(iso)) / 1000;
          if (!(s >= 0)) return "";
          if (s < 60) return "just now";
          if (s < 3600) return Math.floor(s / 60) + " min ago";
          if (s < 86400) return Math.floor(s / 3600) + " h ago";
          if (s < 86400 * 30) return Math.floor(s / 86400) + " d ago";
          return new Date(iso).toLocaleDateString();
        }
        function size(n) { return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
        function label(parent, str, x, y, tw, h, o) {
          var t = new lively.morphic.Text(lively.rect(x, y, tw, h), str);
          t.applyStyle({
            allowInput: false, fontFamily: "Arial, sans-serif", fontSize: o.size, fontWeight: o.bold ? "bold" : "normal",
            textColor: o.color, padding: lively.rect(0, 0, 0, 0), fill: null, borderWidth: 0,
            fixedWidth: true, fixedHeight: true, clipMode: "hidden",
          });
          parent.addMorph(t);
          t.ignoreEvents();
          return t;
        }

        var items = d.items;
        if (items === null) {
          label(list, "Reading your worlds…", 10, 12, W - 20, 20, { size: 9, color: MUTED });
          return;
        }
        if (!items.length) {
          var msg = d.q.trim()
            ? "No world matches “" + d.q.trim() + "”."
            : "No saved worlds yet. Choose New world… to start one, or save the world you are in from its menu.";
          var empty = label(list, msg, 10, 12, W - 20, 40, { size: 9, color: MUTED });
          empty.name = "emptyText";
          return;
        }
        items.slice(0, 200).forEach(function (it, i) {
          var row = new lively.morphic.Box(lively.rect(0, i * ROW_H, W, ROW_H));
          row.applyStyle({ fill: null, borderWidth: 0 });
          row.name = "worldRow";
          row.worldName = it.name;
          row.draggingEnabled = false; row.grabbingEnabled = false; row.droppingEnabled = false;
          row.handStyle = "pointer";
          list.addMorph(row);
          var nameT = label(row, it.name, 10, 5, W - 20, 18, { size: 10, bold: true, color: INK });
          nameT.name = "worldName";
          var bits = [];
          if (it.last) bits.push("last saved");
          bits.push("saved " + ago(it.savedAt));
          bits.push(size(it.bytes));
          if (it.tags && it.tags.length) bits.push(it.tags.map(function (t) { return "#" + t; }).join(" "));
          var meta = label(row, bits.join("  ·  "), 10, 24, W - 20, 14, { size: 8, color: MUTED });
          meta.name = "worldMeta";
          var extra = it.snippet || it.note || "";
          if (extra) {
            var ex = label(row, extra, 10, 37, W - 20, 14, { size: 8, color: Color.rgb(96, 90, 120) });
            ex.name = "worldSnippet";
          }
          row.onMouseUp = function (evt) { self.onRowClick(it.name); evt.stop(); return true; };
          self.paintRow(row, it.name === d.sel);
          // a hairline under each row (an inset shadow: a border written on the node is lost when the morph is added)
          row.renderContext().shapeNode.style.boxShadow = "inset 0 -1px 0 rgba(30,24,44,0.07)";
        });
      },

      // Selection is shown by painting the row's own node as well as its model (a fill set after the first draw can stay out of the DOM).
      paintRow: function paintRow(row, on) {
        row.applyStyle({ fill: on ? Color.rgba(240, 26, 105, 0.09) : null });
        var node = row.renderContext && row.renderContext().shapeNode;
        if (node) node.style.background = on ? "rgba(240,26,105,0.09)" : "";
      },

      onRowClick: function onRowClick(name) {
        var d = this._d, now = Date.now();
        var again = d.clickedName === name && now - d.clickedAt < 450;
        d.clickedName = name; d.clickedAt = now;
        this.select(name);
        if (again) this.onOpen();
      },

      select: function select(name) {
        var d = this._d, list = this.get("worldsList"), self = this;
        d.sel = name;
        (list ? list.submorphs : []).forEach(function (row) { if (row.name === "worldRow") self.paintRow(row, row.worldName === name); });
      },

      // ─── actions ────────────────────────────────────────────────────────────────

      // The world chosen in the list, or null (and the person is told to choose one).
      chosen: function chosen() {
        var d = this._d, it = null;
        (d.items || []).forEach(function (x) { if (x.name === d.sel) it = x; });
        if (!it) this.setStatus("Choose a world in the list first.", true);
        return it;
      },

      onOpen: function onOpen() {
        var self = this, it = this.chosen();
        if (!it) return;
        this.setStatus("Opening “" + it.name + "”…");
        lively.identity.localIdentity.go("world", it.name, function (err) {
          if (err && self.world()) self.setStatus(err.message || String(err), true);
        });
      },

      onNew: function onNew() {
        var self = this;
        $world.prompt("Name for the new world:", function (name) {
          if (name === null || name === undefined || !String(name).trim()) return;
          self.setStatus("Starting “" + String(name).trim() + "”…");
          lively.identity.localIdentity.go("blank", String(name).trim(), function (err) {
            if (err && self.world()) self.setStatus(err.message || String(err), true);
          });
        }, "");
      },

      onRename: function onRename() {
        var self = this, it = this.chosen();
        if (!it) return;
        $world.prompt("New name for “" + it.name + "”:", function (name) {
          if (name === null || name === undefined || !String(name).trim() || String(name).trim() === it.name) return;
          lively.identity.localIdentity.worldRename(it.name, String(name).trim(), function (err, r) {
            if (!self.world()) return;
            if (err) return self.setStatus(err.message || String(err), true);
            self._d.sel = r.name;
            self.setStatus("Renamed.");
            self.load();
          });
        }, it.name);
      },

      // Two questions, one after the other: the tags (comma-separated), then the note. Cancelling the first leaves both as they were.
      onMeta: function onMeta() {
        var self = this, it = this.chosen();
        if (!it) return;
        $world.prompt("Tags for “" + it.name + "” (separate them with commas):", function (tags) {
          if (tags === null || tags === undefined) return;
          $world.prompt("A note about “" + it.name + "”:", function (note) {
            if (note === null || note === undefined) return;
            lively.identity.localIdentity.worldMeta(it.name, String(tags), String(note), function (err) {
              if (!self.world()) return;
              if (err) return self.setStatus(err.message || String(err), true);
              self.setStatus("Saved.");
              self.load();
            });
          }, it.note || "");
        }, (it.tags || []).join(", "));
      },

      onCopy: function onCopy() {
        var self = this, it = this.chosen();
        if (!it) return;
        $world.prompt("Name for the copy of “" + it.name + "”:", function (name) {
          if (name === null || name === undefined || !String(name).trim()) return;
          lively.identity.localIdentity.worldDuplicate(it.name, String(name).trim(), function (err, r) {
            if (!self.world()) return;
            if (err) return self.setStatus(err.message || String(err), true);
            self._d.sel = r.name;
            self.setStatus("Copied.");
            self.load();
          });
        }, it.name + " copy");
      },

      onDelete: function onDelete() {
        var self = this, it = this.chosen();
        if (!it) return;
        $world.confirm("Delete “" + it.name + "” from this device? This cannot be undone.", function (yes) {
          if (!yes) return;
          lively.identity.localIdentity.worldRemove(it.name, function (err) {
            if (!self.world()) return;
            if (err) return self.setStatus(err.message || String(err), true);
            self._d.sel = null;
            self.setStatus("Deleted.");
            self.load();
          });
        });
      },

      // ─── helpers ────────────────────────────────────────────────────────────────

      focusSearch: function focusSearch() {
        var input = this.get("searchInput");
        if (input) input.focus();
      },

      setStatus: function setStatus(msg, isError) {
        if (this._d) this._d.status = msg ? { msg: msg, isError: !!isError } : null;
        var t = this.get("statusText");
        if (!t) return;
        t.setTextString(msg || "");
        t.setTextColor(isError ? Color.rgb(204, 51, 51) : Color.rgb(153, 153, 153));
      },
    });
  }); // end module('lively.identity.WorldLibrary')
