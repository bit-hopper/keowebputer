/**
 * lively.identity.MyFilesBrowser
 *
 * Floating window listing the FILES kept on this device in keo's library: the pictures, videos, sounds and PDFs a person dropped into a
 * world, and (in the desktop app) the ones they pointed to where they lie on the computer. One row per file: its name, what kind it is,
 * how big, when it was added, and whether it is a copy or kept on this computer (and, if kept there and no longer as it was, that it is
 * missing or changed). A search by name as the person types, a filter by kind, "place" to put the file in the world they are in, and a
 * menu to remove it. In the desktop app a button points to another local file.
 *
 * This is the window for the library of a LOCAL identity (shell/keo-library.js, through lively.identity.LocalFiles). It is not the
 * Files app (lively.identity.FilesBrowser), which lists what a host keeps (folders, public and private files, sharing); a host's files
 * and a device's files are different things and neither window knows about the other.
 *
 * Removing a file takes it out of the library. Nothing yet counts which saved worlds show a file, so the confirmation says that worlds
 * which show it will not be able to; for a file kept where it lies only the record goes, never the file on the computer.
 *
 * Methods of a BuildSpec are rebuilt from their source at run time and lose their closure: they use this.* and fully qualified globals only.
 */

module("lively.identity.MyFilesBrowser")
  .requires(
    "lively.identity.DID",
    "lively.identity.LocalIdentity",
    "lively.identity.LocalFiles",
    "lively.data.FileUpload",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {
    lively.BuildSpec("lively.identity.MyFilesBrowser", {
      _Extent: lively.pt(480, 420),
      _BorderRadius: 8,
      // Same frame as My worlds: the window's own fill shows through as a coloured margin around the grey content pane.
      _Fill: Color.rgb(0, 150, 136),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "MyFilesBrowser",
      submorphs: [
        {
          _Extent: lively.pt(474, 395),
          _BorderColor: Color.rgb(95, 94, 95),
          _BorderRadius: 4,
          _Fill: Color.rgb(243, 243, 243),
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          layout: { adjustForNewBounds: true, resizeHeight: true, resizeWidth: true },
          name: "myFilesContent",
          submorphs: [],
        },
      ],

      // Shared with the other identity windows (same style id), so whichever opens first installs it for all.
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

      PAGE: 50,
      KINDS: [
        { label: "All", type: "" },
        { label: "Pictures", type: "image/" },
        { label: "Video", type: "video/" },
        { label: "Sound", type: "audio/" },
        { label: "PDF", type: "application/pdf" },
      ],

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        var self = this;
        this._ensureAccentChromeCss();
        this.addStyleClassName("identity-accent-chrome");
        this.targetMorph = this.get("myFilesContent");
        this.titleBar = this.addMorph(this.makeTitleBar("My files", this.getExtent().x));
        this._query = "";
        this._type = "";
        this._shown = this.PAGE;
        this.buildUI();
        this.load();
        // A file added, pointed at or removed anywhere in this world (a drop, the menu entry, this window) tells the page.
        // remove() runs whenever the window is taken out of the world, which also happens when it is brought forward (taken out and put
        // back at once), so the listener cannot be dropped there. A window that is really closed is not in the world when the next
        // event comes, and stops listening then.
        this._onChanged = function () {
          if (!self.world()) { window.removeEventListener("keo-files-changed", self._onChanged); return; }
          if (self.get("myFilesList")) self.load();
        };
        window.addEventListener("keo-files-changed", this._onChanged);
      },

      remove: function remove() {
        clearTimeout(this._debounce);
        $super();
      },

      // An icon: a Text morph that shows the glyph named `name` (Material Symbols Rounded, vendored with the kernel), `px` pixels tall.
      // fontSize is in points, so a pixel size is multiplied by 0.75 (see the kernel notes on icons). Never measured: it is a square of px.
      iconMorph: function iconMorph(name, px, color, x, y) {
        var t = new lively.morphic.Text(lively.rect(x, y, px + 4, px + 4), name);
        t.applyStyle({ allowInput: false, fontFamily: "'Material Symbols Rounded'", fontSize: px * 0.75, textColor: color, fill: null, borderWidth: 0, borderColor: null });
        t.eventsAreIgnored = true;
        t.draggingEnabled = false; t.droppingEnabled = false; t.grabbingEnabled = false;
        return t;
      },

      // The icon for a kind of file, the same ones the host Files app uses for its families.
      kindIcon: function kindIcon(type) {
        var t = String(type || "");
        if (/^image\//.test(t)) return "image";
        if (/^video\//.test(t)) return "video_file";
        if (/^audio\//.test(t)) return "audio_file";
        if (t === "application/pdf") return "picture_as_pdf";
        return "draft";
      },

      buildUI: function buildUI() {
        var self = this;
        var content = this.get("myFilesContent");
        if (!content) return;
        content.removeAllMorphs();
        var pad = 12, w = content.getExtent().x - pad * 2, y = pad;
        var canPoint = !!(lively.identity.localFiles && lively.identity.localFiles.pointAvailable);
        var pointW = canPoint ? 122 : 0;
        var searchW = w - (canPoint ? pointW + 8 : 0);

        var searchInput = new lively.morphic.Text(lively.rect(pad, y, searchW, 26), "");
        searchInput.name = "searchInput";
        searchInput.applyStyle({
          allowInput: true, fontSize: 12, fill: Color.white, borderWidth: 1, borderColor: Color.rgb(190, 190, 190), borderRadius: 4,
          padding: lively.rect(26, 5, 0, 0),
        });
        searchInput.beInputLine();
        content.addMorph(searchInput);
        // Searched as the person types (a short pause after the last key), from the DOM's own `input` event: a Text morph's onKeyUp can
        // miss keys typed straight after the window opens. The browser's black focus ring is replaced by the accent on the border.
        var inputNode = searchInput.renderContext().shapeNode;
        inputNode.addEventListener("input", function () { self.setQuery(inputNode.textContent); });
        if (!document.getElementById("worlds-browser-style")) {
          var st = document.createElement("style");
          st.id = "worlds-browser-style";
          st.textContent = ".worlds-browser-input, .worlds-browser-input * { outline: none !important; }";
          document.head.appendChild(st);
        }
        inputNode.classList.add("worlds-browser-input");
        inputNode.addEventListener("focusin", function () { inputNode.style.borderColor = "rgb(240,26,105)"; });
        inputNode.addEventListener("focusout", function () { inputNode.style.borderColor = "rgb(190,190,190)"; });

        var searchIcon = new lively.morphic.Text(lively.rect(pad + 6, y + 5, 16, 16), "search");
        searchIcon.applyStyle({ allowInput: false, fontFamily: "'Material Symbols Rounded'", fontSize: 12, textColor: Color.rgb(150, 150, 150), fill: null, borderWidth: 0, borderColor: null });
        searchIcon.eventsAreIgnored = true;
        searchIcon.draggingEnabled = false; searchIcon.droppingEnabled = false; searchIcon.grabbingEnabled = false;
        content.addMorph(searchIcon);
        searchIcon.renderContext().shapeNode.style.pointerEvents = "none";

        if (canPoint) {
          var pointBtn = new lively.morphic.Text(lively.rect(pad + searchW + 8, y, pointW, 26), "Point to a file");
          var pointIcon = null;
          pointBtn.name = "pointBtn";
          pointBtn.applyStyle({
            allowInput: false, fontSize: 11, fontWeight: "bold", textColor: Color.rgb(240, 26, 105), fill: Color.rgb(255, 240, 247),
            borderWidth: 1, borderColor: Color.rgb(240, 190, 210), borderRadius: 5, align: "center",
          });
          pointBtn.draggingEnabled = false; pointBtn.droppingEnabled = false; pointBtn.grabbingEnabled = false;
          pointBtn.renderContext().shapeNode.style.cursor = "pointer";
          pointBtn.onMouseOver = function () { pointBtn.setFill(Color.rgb(255, 224, 238)); };
          pointBtn.onMouseOut = function () { pointBtn.setFill(Color.rgb(255, 240, 247)); };
          pointBtn.onMouseUp = function (evt) { self.pointToFile(); if (evt && evt.stop) evt.stop(); return true; };
          content.addMorph(pointBtn);
          // the icon sits on the button's left edge and lets every click through to the button
          pointIcon = self.iconMorph("attach_file", 14, Color.rgb(240, 26, 105), pad + searchW + 8 + 7, y + 5);
          content.addMorph(pointIcon);
          pointIcon.renderContext().shapeNode.style.pointerEvents = "none";
        }
        y += 34;

        // the kind filter: a row of words, the chosen one in the accent colour
        var x = pad + 2;
        this.KINDS.forEach(function (k) {
          var tw = k.label.length * 7 + 10;
          var t = new lively.morphic.Text(lively.rect(x, y, tw, 18), k.label);
          t.name = "kind_" + (k.type || "all");
          t.applyStyle({ allowInput: false, fontSize: 11, fill: null, borderWidth: 0, borderColor: null, textColor: Color.rgb(0, 121, 107) });
          t.draggingEnabled = false; t.droppingEnabled = false; t.grabbingEnabled = false;
          t.renderContext().shapeNode.style.cursor = "pointer";
          t.onMouseUp = function (evt) { self.setKind(k.type); if (evt && evt.stop) evt.stop(); return true; };
          content.addMorph(t);
          x += tw + 4;
        });
        y += 26;
        this.paintKinds();

        var listH = content.getExtent().y - y - pad - 22;
        var listBox = new lively.morphic.Box(lively.rect(pad, y, w, listH));
        listBox.name = "myFilesList";
        listBox.applyStyle({ fill: Color.white, clipMode: "auto", borderWidth: 1, borderColor: Color.rgb(220, 220, 220), borderRadius: 3 });
        content.addMorph(listBox);
        var s = listBox.renderContext().shapeNode.style;
        s.overflowX = "hidden"; s.scrollbarWidth = "thin"; s.scrollbarColor = "rgb(190, 190, 190) transparent"; s.scrollbarGutter = "stable";

        var statusText = new lively.morphic.Text(lively.rect(pad, y + listH + 3, w, 16), "");
        statusText.name = "myFilesStatus";
        statusText.applyStyle({ allowInput: false, fontSize: 10, textColor: Color.rgb(140, 140, 140), fill: null, borderWidth: 0, borderColor: null });
        statusText.eventsAreIgnored = true;
        content.addMorph(statusText);
      },

      // ── reading the library ──────────────────────────────────────────────────────────────────────────────────────────────

      // Every answer carries the number of the request that asked for it; one that is no longer the latest (the person typed on, or
      // changed the filter) is dropped.
      load: function load() {
        var self = this, seq = this._seq = (this._seq || 0) + 1;
        lively.identity.localFiles.search({ query: (this._query || "").trim(), type: this._type || "", limit: this._shown, offset: 0 }, function (err, r) {
          if (seq !== self._seq || !self.world() || !self.get("myFilesList")) return;
          if (err) return self.showMessage("Could not load your files: " + (err.message || err));
          self._items = r.items || [];
          self._total = r.total || 0;
          self.render(r.unreadable || 0);
          self.refreshSpace();
        });
      },

      setQuery: function setQuery(q) {
        var self = this;
        this._query = String(q == null ? "" : q);
        this._statusMsg = "";
        this._shown = this.PAGE;
        clearTimeout(this._debounce);
        this._debounce = setTimeout(function () { if (self.world() && self.get("myFilesList")) self.load(); }, 150);
      },

      setKind: function setKind(type) {
        this._type = type || "";
        this._statusMsg = "";
        this._shown = this.PAGE;
        this.paintKinds();
        this.load();
      },

      paintKinds: function paintKinds() {
        var self = this, content = this.get("myFilesContent");
        if (!content) return;
        this.KINDS.forEach(function (k) {
          var t = content.get("kind_" + (k.type || "all"));
          if (!t) return;
          var on = (self._type || "") === k.type;
          t.setTextColor(on ? Color.rgb(240, 26, 105) : Color.rgb(0, 121, 107));
          t.applyStyle({ fontWeight: on ? "bold" : "normal" });
        });
      },

      // The line under the list: what an action did, or, when there is nothing to say, how much the library's files take and how much
      // room is left for more (the last answer from the shell).
      setStatus: function setStatus(msg, isError) {
        var t = this.get("myFilesStatus");
        if (!t) return;
        this._statusMsg = msg || "";
        t.setTextString(this._statusMsg || this._spaceText || "");
        t.setTextColor(isError ? Color.rgb(200, 50, 50) : Color.rgb(140, 140, 140));
      },

      refreshSpace: function refreshSpace() {
        var self = this, li = lively.identity.localIdentity, lf = lively.identity.localFiles;
        if (!li || typeof li.libSpace !== "function") return;
        li.libSpace(function (err, sp) {
          if (err || !self.world() || !self.get("myFilesStatus")) return;
          var files = sp.files > 0 ? "Files " + lf.sizeText(sp.files, false) : "No files yet";
          if (typeof sp.free !== "number") self._spaceText = sp.files > 0 ? files : "";
          else self._spaceText = files + " · " + (sp.free > 0 ? "room for about " + lf.sizeText(sp.free, true) + " more" : "no room left for more");
          if (!self._statusMsg) self.setStatus("");
        });
      },

      showMessage: function showMessage(msg, icon) {
        var listBox = this.get("myFilesList");
        if (!listBox) return;
        listBox.removeAllMorphs();
        var y = 10, w = listBox.getExtent().x;
        if (icon) {
          // centred above the words; the glyph is a square of 40 pixels
          var big = this.iconMorph(icon, 40, Color.rgb(205, 205, 205), Math.round((w - 44) / 2), 24);
          big.name = "messageIcon";
          listBox.addMorph(big);
          y = 84;
        }
        var t = new lively.morphic.Text(lively.rect(10, y, w - 20, icon ? 40 : 20), msg);
        t.applyStyle({ allowInput: false, fontSize: 11, textColor: Color.rgb(130, 130, 130), fill: null, borderWidth: 0, borderColor: null, align: icon ? "center" : "left" });
        listBox.addMorph(t);
      },

      // ── the rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────

      render: function render(unreadable) {
        var self = this, listBox = this.get("myFilesList"), items = this._items || [];
        if (!listBox) return;
        listBox.removeAllMorphs();
        if (!items.length) {
          var q = (this._query || "").trim();
          var canPoint = !!(lively.identity.localFiles && lively.identity.localFiles.pointAvailable);
          return this.showMessage(q || this._type
            ? "No file matches."
            : "No files yet. Drop a picture, video, sound or PDF onto a world" + (canPoint ? ", or choose Point to a file." : "."),
            q || this._type ? "search_off" : "folder_open");
        }
        var lf = lively.identity.localFiles;
        var cw = listBox.renderContext().shapeNode.clientWidth;
        var w = cw > 0 ? cw : listBox.getExtent().x - 16, y = 4;
        var PINK = Color.rgb(240, 26, 105), PINK_HOVER = Color.rgb(190, 15, 82), GRAY = Color.rgb(150, 150, 150), GRAY_HOVER = Color.rgb(90, 90, 90);
        var ROW_HOVER = Color.rgb(224, 247, 244);

        function ago(iso) {
          var s = (Date.now() - Date.parse(iso)) / 1000;
          if (!(s >= 0)) return "";
          if (s < 60) return "just now";
          if (s < 3600) return Math.floor(s / 60) + " min ago";
          if (s < 86400) return Math.floor(s / 3600) + " h ago";
          if (s < 86400 * 30) return Math.floor(s / 86400) + " d ago";
          return new Date(iso).toLocaleDateString();
        }
        function label(parent, str, x, yy, tw, h, size, color, bold, name) {
          var t = new lively.morphic.Text(lively.rect(x, yy, tw, h), str);
          t.applyStyle({ allowInput: false, fontSize: size, fontWeight: bold ? "bold" : "normal", textColor: color, fill: null, borderWidth: 0, borderColor: null });
          t.eventsAreIgnored = true;
          t.draggingEnabled = false; t.droppingEnabled = false; t.grabbingEnabled = false;
          if (name) t.name = name;
          parent.addMorph(t);
          return t;
        }
        // Acts when the mouse button comes UP: a menu opened on the way down is removed by the world's own handling of the same click.
        function link(parent, str, x, yy, tw, color, hover, onClick, font) {
          var t = new lively.morphic.Text(lively.rect(x, yy, tw, 18), str);
          var style = { allowInput: false, fontSize: font ? 16 : 12, textColor: color, fill: null, borderWidth: 0, borderColor: null };
          if (font) style.fontFamily = font;
          t.applyStyle(style);
          t.draggingEnabled = false; t.droppingEnabled = false; t.grabbingEnabled = false;
          t.renderContext().shapeNode.style.cursor = "pointer";
          t.onMouseOver = function () { t.setTextColor(hover); };
          t.onMouseOut = function () { t.setTextColor(color); };
          t.onMouseUp = function (evt) { onClick(); if (evt && evt.stop) evt.stop(); return true; };
          parent.addMorph(t);
          return t;
        }

        items.forEach(function (it) {
          var row = new lively.morphic.Box(lively.rect(0, y, w, 52));
          row.applyStyle({ fill: null, borderWidth: 0 });
          row.name = "fileRow";
          row.fileId = it.id;
          row.draggingEnabled = false; row.droppingEnabled = false; row.grabbingEnabled = false;
          row.onMouseOver = function () { row.setFill(ROW_HOVER); };
          row.onMouseOut = function () { row.setFill(null); };

          var kindIcon = self.iconMorph(self.kindIcon(it.type), 26, Color.rgb(150, 150, 150), 10, 11);
          kindIcon.name = "fileKind";
          row.addMorph(kindIcon);
          label(row, it.name, 46, 7, w - 156, 20, 13, Color.rgb(40, 40, 40), true, "fileName");
          var bits = [lf.kindWord(it.type), lf.sizeText(it.size, false), "added " + ago(it.created)];
          if (it.pointed) bits.push("kept on this computer");
          var meta = label(row, bits.join("  ·  "), 46, 29, w - 56, 14, 10, Color.rgb(170, 170, 170), false, "fileMeta");
          if (it.pointed) self.checkPointed(it, meta, bits);

          var more = link(row, "more_horiz", w - 24, 14, 26, GRAY, GRAY_HOVER, function () { self.openRowMenu(it); }, "'Material Symbols Rounded'");
          more.name = "fileMore";
          var place = link(row, "add_photo_alternate", w - 50, 14, 26, PINK, PINK_HOVER, function () { self.place(it); }, "'Material Symbols Rounded'");
          place.name = "filePlace";
          if (place.setToolTip) place.setToolTip("Place in world");

          var sep = new lively.morphic.Box(lively.rect(10, 51, w - 20, 1));
          sep.applyStyle({ fill: Color.rgb(225, 225, 225), borderWidth: 0 });
          row.addMorph(sep);
          listBox.addMorph(row);
          y += 54;
        });
        if (this._total > items.length) {
          var more2 = link(listBox, "Show more (" + (this._total - items.length) + " more)", 10, y + 4, w - 20, PINK, PINK_HOVER, function () { self._shown += self.PAGE; self.load(); });
          more2.name = "fileShowMore";
        }
        // What an action said stays until the person searches, filters or acts again; otherwise the line shows the room left.
        if (unreadable) this.setStatus(unreadable + (unreadable === 1 ? " file" : " files") + " could not be read and " + (unreadable === 1 ? "is" : "are") + " not listed.", true);
        else if (!this._statusMsg) this.setStatus("");
      },

      // A file kept where it lies: ask the shell whether it is still as it was, and say so on the row if it is not.
      checkPointed: function checkPointed(it, meta, bits) {
        var self = this;
        lively.identity.localFiles.info(it.id, function (err, info) {
          if (err || !info || !self.world() || !meta.owner) return;
          var words = { missing: "file missing", changed: "file changed", denied: "cannot open file" }[info.state];
          if (!words) return;
          it.state = info.state;
          meta.setTextString(bits.join("  ·  ") + "  ·  " + words);
          meta.setTextColor(Color.rgb(192, 57, 43));
        });
      },

      // ── what a person can do with a file ─────────────────────────────────────────────────────────────────────────────────

      openRowMenu: function openRowMenu(it) {
        var self = this, items = [["Place in world", function () { self.place(it); }]];
        if (it.pointed && it.state && it.state !== "ok" && lively.identity.localFiles.pointAvailable) items.push(["Point to it again …", function () { self.pointToFile(); }]);
        items.push([it.pointed ? "Stop using this file …" : "Remove from library …", function () { self.removeFile(it); }]);
        lively.morphic.Menu.openAtHand(it.name, items);
      },

      place: function place(it) {
        var self = this;
        var info = { name: it.name, type: it.type, size: it.size, ref: { handle: lively.identity.localFiles.HANDLE, objId: it.id, blobCid: it.id } };
        lively.data.FileUpload.placeLibraryFile(info, function (err) {
          if (!self.world()) return;
          self.setStatus(err ? (err.message || String(err)) : "Placed “" + it.name + "” in the world.", !!err);
        });
      },

      removeFile: function removeFile(it) {
        var self = this, lf = lively.identity.localFiles;
        var text = it.pointed
          ? "Stop using “" + it.name + "”? The file on your computer is not deleted. Worlds that show it will not be able to show it any more."
          : "Remove “" + it.name + "” (" + lf.sizeText(it.size, false) + ") from your library? Worlds that show it will not be able to show it any more. This cannot be undone.";
        $world.confirm(text, function (yes) {
          if (!yes) return;
          lf.remove(it.id, function (err) {
            if (!self.world()) return;
            if (err) return self.setStatus(err.message || String(err), true);
            self.setStatus("Removed “" + it.name + "”.");
          });
        });
      },

      // The desktop app only: the shell asks which file, and keeps it where it lies. The file is added to the list; "place" puts it in the world.
      pointToFile: function pointToFile() {
        var self = this;
        lively.identity.localFiles.point(function (err, info) {
          if (!self.world()) return;
          if (err) return self.setStatus(err.message || String(err), true);
          if (!info) return;
          if (info.existed && !info.pointed) return self.setStatus("“" + info.name + "” is already in your library as a copy, which is kept.");
          self.setStatus("Added “" + info.name + "”, kept where it is on this computer.");
        });
      },
    });
  });
