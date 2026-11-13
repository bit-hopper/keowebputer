/**
 * lively.identity.MyFilesBrowser
 *
 * Floating window for the FILES kept on this device in keo's library: the pictures, videos, sounds and PDFs a person dropped into a
 * world, and (in the desktop app) the ones they pointed to where they lie on the computer. Three rounded panels: the folders, the
 * files (one white card each: its name, what it is, how big, when it was added, whether it is stored on this computer) and a preview
 * of the chosen file with its details and the buttons. Search by name, filter by kind, sort; rename a file (double-click its name,
 * F2 or the pencil); put files in folders (drag them onto one, or "Move to …"); place a file in the world they are in; remove it.
 * In the desktop app a button points to another local file.
 *
 * This is the window for the library of a LOCAL identity (shell/keo-library.js, through lively.identity.LocalFiles). It is not the
 * Files app (lively.identity.FilesBrowser), which lists what a host keeps (folders, public and private files, sharing); a host's files
 * and a device's files are different things and neither window knows about the other.
 *
 * Built like FilesBrowser: a Box in a classic Window whose content is plain DOM (the list, the inline name field and the drag onto a
 * folder are far simpler there than as a tree of morphs). Mouse and keys inside it are the browser's own; the one thing Lively gets
 * in the way of is a drop, which the world takes first and hands to onHTML5Drag/onHTML5Drop (see the kernel notes).
 *
 * Removing a file takes it out of the library. Nothing yet counts which saved worlds show a file, so the confirmation says that worlds
 * which show it will not be able to; for a file kept where it lies only the record goes, never the file on the computer. Deleting a
 * folder never deletes a file: its files and folders go up a level.
 *
 * Not here yet: "Duplicate" (not planned: one copy of the same bytes is kept), the WarpDrop button, the "Used in" line.
 */

module("lively.identity.MyFilesBrowser")
  .requires(
    "lively.identity.DID",
    "lively.identity.LocalIdentity",
    "lively.identity.LocalFiles",
    "lively.data.FileUpload",
    "lively.morphic.Complete"
  )
  .toRun(function () {
    var NAME = "MyFilesBrowser";
    var PAGE = 50;
    var KINDS = [
      { label: "All", type: "" },
      { label: "Pictures", type: "image/" },
      { label: "Videos", type: "video/" },
      { label: "Audios", type: "audio/" },
      { label: "Docs", type: lively.identity.localFiles.DOC_KINDS }      // PDF, markdown, text, web page, book, word-processor file
    ];
    var SORTS = [["added", "Newest first"], ["name", "Name"], ["size", "Largest first"], ["type", "Type"]];
    var MAX_THUMB = 8 * 1024 * 1024;       // a picture bigger than this is not drawn in the preview (it is read whole to do so)

    // The colours are the Files browser's blue (its title bar, accents and soft fills); the primary button stays green.
    function ensureStyle() {
      var ID = "my-files-browser-style";
      if (document.getElementById(ID)) return;
      var st = document.createElement("style");
      st.id = ID;
      st.textContent = [
        ".Window.myfiles-chrome { background-color: #2563eb !important; border-radius: 12px !important; }",
        ".Window.myfiles-chrome .Text.window-title { color: #fff; }",
        ".Window.myfiles-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }",
        ".Window.myfiles-chrome.highlighted { border: none !important; box-shadow: 0px 3px 10px rgba(10,30,80,0.35) !important; }",
        ".mf-root { position: absolute; inset: 0; box-sizing: border-box; background: #f3f3f3; border: 1px solid #5f5e5f; border-radius: 10px; overflow: hidden;",
        "  display: flex; flex-direction: column; padding: 10px 12px 6px; gap: 8px; font: 12px Arial, Helvetica, sans-serif; color: #282828; }",
        ".mf-root *, .mf-root *::before, .mf-root *::after { box-sizing: border-box; }",
        ".mf-root [hidden] { display: none !important; }",
        ".mf-root input, .mf-root select { user-select: text; }",
        ".mf-root button { font-family: Arial, Helvetica, sans-serif; }",
        ".mf-ms { font-family: 'Material Symbols Rounded'; font-weight: normal; font-style: normal; font-size: 20px; line-height: 1; letter-spacing: normal; text-transform: none; white-space: nowrap; user-select: none; }",
        ".mf-bar, .mf-bar2 { display: flex; align-items: center; gap: 8px; flex: none; }",
        ".mf-search { flex: 1; position: relative; }",
        ".mf-search .mf-ms { position: absolute; left: 8px; top: 7px; font-size: 14px; color: #969696; pointer-events: none; }",
        ".mf-search input { width: 100%; height: 28px; border: 1px solid #93c5fd; border-radius: 4px; padding: 0 8px 0 28px; font: 12px Arial, Helvetica, sans-serif; background: #fff; color: #282828; outline: 0; }",
        ".mf-search input:focus { border-color: #2563eb; }",
        ".mf-point { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; font-size: 11px; font-weight: bold; color: #2563eb; background: #dbeafe; border: 1px solid #93c5fd; border-radius: 5px; cursor: pointer; }",
        ".mf-point .mf-ms { font-size: 14px; } .mf-point:hover { background: #bfdbfe; }",
        // the pill: the same button with fully rounded ends, for what comes from another device (the files mock-up's lightning pill)
        ".mf-point.mf-pill { border-radius: 15px; padding: 0 12px 0 9px; }",
        ".mf-point + .mf-point { margin-left: 6px; }",
        ".mf-kinds { display: flex; flex-wrap: wrap; gap: 6px; }",
        ".mf-kinds button { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 12px; padding: 2px 11px; font-size: 11px; color: #2563eb; cursor: pointer; }",
        ".mf-kinds button:hover { background: #dbeafe; }",
        ".mf-kinds button[aria-pressed=true] { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: bold; }",
        ".mf-sort { margin-left: auto; height: 24px; font: 11px Arial, Helvetica, sans-serif; border: 1px solid #bebebe; border-radius: 4px; background: #fff; color: #282828; }",
        ".mf-mid { flex: 1; min-height: 0; display: flex; gap: 10px; }",
        ".mf-center { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }",
        ".mf-side { width: clamp(120px, 21%, 168px); flex: none; background: #e9e9e9; border: 1px solid #dcdcdc; border-radius: 10px; overflow-y: auto; padding: 6px 4px; scrollbar-width: thin; }",
        ".mf-sh { display: flex; align-items: center; justify-content: space-between; padding: 2px 6px 4px; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: #8a8a8a; }",
        ".mf-sh button { background: none; border: 0; color: #2563eb; cursor: pointer; padding: 0; display: flex; } .mf-sh button .mf-ms { font-size: 16px; } .mf-sh button:hover { color: #1d4ed8; }",
        ".mf-loc { display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 4px; cursor: pointer; border: 1px solid transparent; font-size: 12px; }",
        ".mf-loc .mf-ms { font-size: 16px; color: #969696; flex: none; }",
        ".mf-loc .mf-n { margin-left: auto; color: #8a8a8a; font-size: 10px; flex: none; }",
        ".mf-loc .mf-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }",
        ".mf-loc:hover { background: #eff6ff; }",
        ".mf-loc.on { background: #dbeafe; color: #2563eb; font-weight: bold; } .mf-loc.on .mf-ms { color: #2563eb; }",
        ".mf-loc.over { border-color: #2563eb; background: #dbeafe; }",
        ".mf-loc input { width: 100%; font: 12px Arial, Helvetica, sans-serif; border: 1px solid #2563eb; border-radius: 3px; padding: 1px 4px; outline: 0; min-width: 0; }",
        ".mf-selbar { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; padding: 5px 10px; white-space: nowrap; background: #dbeafe; border: 1px solid #93c5fd; border-radius: 4px; color: #2563eb; font-size: 11px; font-weight: bold; flex: none; }",
        ".mf-selbar button { background: none; border: 0; color: #2563eb; font-size: 11px; white-space: nowrap; cursor: pointer; padding: 0; } .mf-selbar button:hover { color: #1d4ed8; text-decoration: underline; }",
        ".mf-selbar .mf-clr { margin-left: auto; font-weight: normal; }",
        ".mf-list { flex: 1; min-height: 0; background: #e9e9e9; border: 1px solid #dcdcdc; border-radius: 10px; padding: 8px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #bebebe transparent; scrollbar-gutter: stable; position: relative; }",
        ".mf-row { position: relative; display: flex; align-items: center; gap: 10px; height: 52px; margin: 0 0 6px; padding: 0 8px 0 12px; background: #fff; border: 1px solid #d9d9d9; border-radius: 8px; cursor: default; }",
        ".mf-row:hover { background: #eff6ff; border-color: #bfdbfe; }",
        ".mf-row.sel, .mf-row.sel:hover { background: #dbeafe; border-color: #93c5fd; }",
        ".mf-row.dragging { opacity: .45; }",
        ".mf-lead { position: relative; width: 26px; height: 26px; flex: none; }",
        ".mf-lead .mf-kind { font-size: 26px; color: #969696; position: absolute; inset: 0; }",
        ".mf-chk { position: absolute; left: 3px; top: 3px; width: 20px; height: 20px; border-radius: 4px; border: 1.5px solid #9a9a9a; background: #fff; display: none; align-items: center; justify-content: center; padding: 0; cursor: pointer; color: #fff; }",
        ".mf-chk .mf-ms { font-size: 16px; visibility: hidden; }",
        ".mf-row:hover .mf-chk, .mf-anysel .mf-chk { display: flex; }",
        ".mf-row:hover .mf-kind, .mf-anysel .mf-row .mf-kind { display: none; }",
        ".mf-row.sel .mf-chk { background: #2563eb; border-color: #2563eb; } .mf-row.sel .mf-chk .mf-ms { visibility: visible; }",
        ".mf-txt { flex: 1; min-width: 0; }",
        ".mf-nmx { font-size: 13px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: baseline; }",
        ".mf-ext { color: #8a8a8a; font-weight: normal; }",
        ".mf-meta { font-size: 10px; color: #8a8a8a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 3px; }",
        ".mf-meta .mf-bad { color: #c0392b; }",
        ".mf-act { background: none; border: 0; padding: 0; cursor: pointer; color: #969696; display: flex; } .mf-act .mf-ms { font-size: 18px; } .mf-act:hover { color: #5a5a5a; }",
        ".mf-rename { font: bold 13px Arial, Helvetica, sans-serif; border: 1px solid #2563eb; border-radius: 3px; padding: 1px 4px; outline: 0; min-width: 40px; width: auto; flex: 0 1 220px; background: #fff; color: #282828; }",
        ".mf-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 54px 24px; color: #828282; text-align: center; font-size: 11px; }",
        ".mf-empty .mf-ms { font-size: 40px; color: #cdcdcd; }",
        ".mf-more { display: block; margin: 4px auto 2px; background: none; border: 0; color: #2563eb; font-size: 12px; cursor: pointer; } .mf-more:hover { text-decoration: underline; }",
        ".mf-prev { width: clamp(170px, 29%, 232px); flex: none; background: #fff; border: 1px solid #dcdcdc; border-radius: 10px; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 9px; scrollbar-width: thin; }",
        // the view switch (list / grid) next to the sort menu
        ".mf-seg { display: flex; flex: none; border: 1px solid #bebebe; border-radius: 4px; overflow: hidden; background: #fff; }",
        ".mf-seg button { display: flex; align-items: center; justify-content: center; width: 28px; height: 22px; padding: 0; border: 0; background: #fff; color: #6a6a6a; cursor: pointer; }",
        ".mf-seg button + button { border-left: 1px solid #bebebe; }",
        ".mf-seg button .mf-ms { font-size: 16px; } .mf-seg button:hover { background: #eff6ff; }",
        ".mf-seg button[aria-pressed=true] { background: #2563eb; color: #fff; }",
        // a picture's small picture in a list row, and the grid of tiles
        ".mf-lead.mf-has { width: 38px; height: 38px; }",
        ".mf-timg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border-radius: 5px; border: 1px solid #e1e1e1; background: #f3f3f3; }",
        ".mf-list.mf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 8px; align-content: start; }",
        ".mf-list.mf-grid .mf-more { grid-column: 1 / -1; }",
        ".mf-tile { flex-direction: column; align-items: stretch; height: auto; margin: 0; padding: 6px; gap: 5px; min-width: 0; }",
        ".mf-tile .mf-th { background: #f3f3f3; } .mf-tile .mf-th .mf-ms { font-size: 30px; } .mf-tile .mf-th img { object-fit: cover; }",
        ".mf-tile .mf-chk { left: 11px; top: 11px; }",
        ".mf-tile:hover .mf-chk, .mf-anysel .mf-tile .mf-chk { display: flex; }",
        ".mf-tile .mf-act { position: absolute; right: 9px; top: 9px; display: none; background: rgba(255, 255, 255, .92); border-radius: 4px; padding: 2px; }",
        ".mf-tile:hover .mf-act { display: flex; }",
        ".mf-tile .mf-nmx { font-size: 12px; } .mf-tile .mf-meta { margin-top: 1px; } .mf-tile .mf-rename { max-width: 100%; flex: 1 1 auto; font-size: 12px; }",
        ".mf-th { width: 100%; aspect-ratio: 4 / 3; border-radius: 4px; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #f3f3f3; border: 1px solid #e1e1e1; flex: none; }",
        ".mf-th .mf-ms { font-size: 44px; color: #b4b4b4; } .mf-th img { width: 100%; height: 100%; object-fit: contain; }",
        ".mf-pn { display: flex; align-items: flex-start; gap: 4px; }",
        ".mf-pn .mf-t { flex: 1; min-width: 0; font-size: 14px; font-weight: bold; overflow-wrap: anywhere; }",
        ".mf-prev dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; font-size: 11px; }",
        ".mf-prev dt { color: #8a8a8a; } .mf-prev dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }",
        ".mf-lnk { color: #2563eb; cursor: pointer; background: none; border: 0; padding: 0; font-size: 11px; text-align: left; } .mf-lnk:hover { text-decoration: underline; }",
        ".mf-pbtns { display: flex; flex-direction: column; gap: 6px; margin-top: auto; }",
        ".mf-primary { background: #2f9e5b; color: #fff; border: 0; border-radius: 4px; height: 28px; font-size: 12px; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px; }",
        ".mf-primary:hover { background: #26864c; } .mf-primary .mf-ms { font-size: 16px; } .mf-primary[disabled] { background: #b9c9bf; cursor: default; }",
        ".mf-line { background: #fff; color: #282828; border: 1px solid #bebebe; border-radius: 4px; height: 26px; font-size: 11px; cursor: pointer; } .mf-line:hover { border-color: #2563eb; color: #2563eb; }",
        ".mf-pempty { color: #828282; font-size: 11px; text-align: center; margin: auto 0; display: flex; flex-direction: column; align-items: center; gap: 6px; } .mf-pempty .mf-ms { font-size: 32px; color: #cdcdcd; }",
        ".mf-status { min-height: 16px; font-size: 10px; color: #8c8c8c; display: flex; gap: 8px; align-items: baseline; flex: none; }",
        ".mf-status.err { color: #c0392b; }",
        ".mf-status button { background: none; border: 0; padding: 0; font-size: 10px; font-weight: bold; color: #2563eb; cursor: pointer; } .mf-status button:hover { text-decoration: underline; }",
        ".mf-pop { position: absolute; z-index: 5; min-width: 168px; background: #f7f7f7; border: 1px solid #8c8c8c; border-radius: 3px; box-shadow: 0 4px 14px rgba(0,0,0,.28); padding: 2px 0; font-size: 12px; }",
        ".mf-pop .mf-it { display: flex; align-items: center; gap: 6px; padding: 4px 12px; cursor: pointer; color: #282828; white-space: nowrap; }",
        ".mf-pop .mf-it:hover { background: #2563eb; color: #fff; }",
        ".mf-pop .mf-it .mf-ms { font-size: 15px; width: 15px; }",
        ".mf-pop .mf-sep { height: 1px; background: #d6d6d6; margin: 3px 0; }",
        ".mf-pop .mf-hd { padding: 3px 12px; font-size: 10px; color: #8a8a8a; text-transform: uppercase; letter-spacing: .05em; }",
        ".mf-pop .mf-newrow { padding: 4px 8px; } .mf-pop .mf-newrow input { width: 100%; font: 12px Arial, Helvetica, sans-serif; border: 1px solid #bebebe; border-radius: 3px; padding: 2px 5px; outline: 0; } .mf-pop .mf-newrow input:focus { border-color: #2563eb; }",
        ".mf-pop .mf-hint { padding: 3px 12px 4px; font-size: 10px; color: #8a8a8a; max-width: 220px; white-space: normal; }"
      ].join("\n");
      document.head.appendChild(st);
    }

    function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
    function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
    function ago(iso) {
      var s = (Date.now() - Date.parse(iso)) / 1000;
      if (!(s >= 0)) return "";
      if (s < 60) return "just now";
      if (s < 3600) return Math.floor(s / 60) + " min ago";
      if (s < 86400) return Math.floor(s / 3600) + " h ago";
      if (s < 86400 * 30) return Math.floor(s / 86400) + " d ago";
      return new Date(iso).toLocaleDateString();
    }
    // "Beach.jpg" -> { base: "Beach", ext: "jpg" }; a name with no ending (or only a leading dot) is all base.
    function splitName(name) {
      var m = /^(.*[^.])\.([A-Za-z0-9]{1,5})$/.exec(String(name || ""));
      return m ? { base: m[1], ext: m[2] } : { base: String(name || ""), ext: "" };
    }
    function typeWord(it) {
      var t = String(it.type || "");
      if (/^image\//.test(t)) return "Picture";
      if (/^video\//.test(t)) return "Video";
      if (/^audio\//.test(t)) return "Audio";
      if (t === "application/pdf") return "PDF";
      var e = splitName(it.name).ext;
      return e ? e.toUpperCase() : "File";
    }
    function iconFor(it) {
      var t = String(it.type || "");
      if (/^image\//.test(t)) return "image";
      if (/^video\//.test(t)) return "video_file";
      if (/^audio\//.test(t)) return "audio_file";
      if (lively.identity.localFiles.isDocType(t)) return "picture_as_pdf";      // every document wears the PDF sign
      return "draft";
    }
    function nameHtml(it) { var p = splitName(it.name); return esc(p.base) + (p.ext ? '<span class="mf-ext">.' + esc(p.ext) + "</span>" : ""); }
    function lf() { return lively.identity.localFiles; }

    lively.morphic.Box.subclass("lively.identity.MyFilesBrowser",

      "serialization", {
        doNotSerialize: ["_root", "_els", "_items", "_folders", "_thumbUrl"]
      },

      "initialization", {

        initialize: function ($super, bounds) {
          $super(bounds);
          this._query = "";
          this._kind = "";
          this._sort = "added";
          this._view = "list";        // "list" or "grid" (small pictures as tiles)
          this._loc = "all";          // "all", "unsorted" or a folder's id
          this._pageSize = PAGE;
          this._shown = PAGE;
          this._items = [];
          this._total = 0;
          this._folders = { folders: [], unsorted: 0, all: 0, unreadable: 0 };
          this._sel = [];
          this._last = null;
          this._renaming = null;
          this._folderEdit = null;    // { id } to rename a folder, { id: null } for a new one
          this._menu = null;
          this._status = null;        // { text, err, undo }
          this._pointState = {};
          this._drag = null;
          this._unreadable = 0;
          this._spaceText = "";
          this._buildChrome();
          this._wire();
          var self = this;
          lf().checkPointAvailable(function () { if (self.world()) self._renderBar(); });
          lively.identity.localIdentity.checkPhoneAvailable(function () { if (self.world()) self._renderBar(); });
          this.load();
        },

        // A world saved with this window open brings it back with its state but not its page content (that is not saved): build it
        // again and read the library.
        // The page content can only be put into the morph's node once the morph is in the world and drawn (before that the node a
        // restored morph has is replaced when it is first drawn), so this waits for that, for a few seconds at most.
        onrestore: function () {
          if (this._root) return;
          var self = this, tries = 0;
          (function wait() {
            if (self._root) return;
            var drawn = false;
            try { drawn = !!(self.world() && self.renderContext() && self.renderContext().shapeNode); } catch (e) { drawn = false; }
            if (!drawn) { if (++tries < 100) setTimeout(wait, 100); return; }
            self._items = []; self._pointState = {}; self._drag = null; self._menu = null; self._renaming = null; self._folderEdit = null;
            self._status = null; self._sel = []; self._spaceText = ""; self._sig = null;
            self._folders = { folders: [], unsorted: 0, all: 0, unreadable: 0 };
            self._pageSize = PAGE; self._shown = PAGE;
            self._buildChrome();
            self._wire();
            self._els.q.value = self._query || "";
            lf().checkPointAvailable(function () { if (self.world()) self._renderBar(); });
          lively.identity.localIdentity.checkPhoneAvailable(function () { if (self.world()) self._renderBar(); });
            self.load();
          })();
        },

        _buildChrome: function () {
          ensureStyle();
          this.setFill(Color.rgb(37, 99, 235));
          this.setDroppingEnabled(false);
          var node = this.renderContext().shapeNode;
          var root = document.createElement("div");
          root.className = "mf-root";
          root.innerHTML = [
            '<div class="mf-bar"><div class="mf-search"><span class="mf-ms">search</span><input type="text" data-el="q" placeholder="Search files by name" autocomplete="off" aria-label="Search files by name"></div>',
            '<span data-el="point"></span></div>',
            '<div class="mf-bar2"><div class="mf-kinds" data-el="kinds"></div><select class="mf-sort" data-el="sort" aria-label="Sort"></select><div class="mf-seg" data-el="view" role="group" aria-label="View"></div></div>',
            '<div class="mf-mid"><aside class="mf-side" data-el="side"></aside>',
            '<div class="mf-center"><div data-el="sel"></div><div class="mf-list" data-el="list"></div></div>',
            '<aside class="mf-prev" data-el="prev"></aside></div>',
            '<div class="mf-status" data-el="status"></div><div data-el="pop"></div>'
          ].join("");
          node.appendChild(root);
          this._root = root;
          var els = this._els = {};
          Array.prototype.forEach.call(root.querySelectorAll("[data-el]"), function (e) { els[e.getAttribute("data-el")] = e; });
          els.sort.innerHTML = SORTS.map(function (s) { return '<option value="' + s[0] + '">' + s[1] + "</option>"; }).join("");
        }
      },

      "events", {

        _wire: function () {
          var self = this, root = this._root, els = this._els;
          root.addEventListener("click", function (e) { self._onClick(e); });
          // Right-click on a card or a folder: the world would show its own morph menu for the same press, so this is taken before the
          // world sees it (the listener is on the window, in the capture phase).
          this._onContext = function (e) {
            if (!self.world()) { window.removeEventListener("contextmenu", self._onContext, true); return; }
            if (!self._root.contains(e.target)) return;
            var row = e.target.closest(".mf-row"), loc = e.target.closest(".mf-loc[data-folder]");
            if (!row && !loc) return;
            e.preventDefault(); e.stopPropagation();
            if (row) {
              var id = row.getAttribute("data-id");
              if (self._sel.indexOf(id) < 0) { self._sel = [id]; self._last = id; self._renderSel(); self._renderList(); self._renderPrev(); }
              self._openMenu("file", e, self._sel.slice());
            } else self._openMenu("folder", e, [], { folder: loc.getAttribute("data-folder") });
          };
          window.addEventListener("contextmenu", this._onContext, true);
          // The search is typed into a real field; the list is read again a moment after the last key.
          els.q.addEventListener("input", function () {
            self._query = els.q.value; self._shown = self._pageSize; self._status = null;
            clearTimeout(self._debounce);
            self._debounce = setTimeout(function () { if (self.world()) self.load(); }, 150);
          });
          els.sort.addEventListener("change", function () { self._sort = els.sort.value; self._shown = self._pageSize; self.load(); });
          // A file card is dragged by the browser's own drag; the drop is the morph's (onHTML5Drag / onHTML5Drop below).
          root.addEventListener("dragstart", function (e) {
            var row = e.target.closest && e.target.closest(".mf-row");
            if (!row) return;
            var id = row.getAttribute("data-id");
            self._drag = self._sel.indexOf(id) >= 0 ? self._sel.slice() : [id];
            try { e.dataTransfer.setData("text/plain", self._drag.join(",")); e.dataTransfer.effectAllowed = "move"; } catch (x) { /* not essential */ }
            row.classList.add("dragging");
          });
          root.addEventListener("dragend", function () { self._endDrag(); });
          // The keys. A click inside the window leaves the focus on the morph's own wrapper, outside this element, so they are
          // listened for on the document and used only while the focus is in this window.
          this._onKey = function (e) {
            if (!self.world()) { document.removeEventListener("keydown", self._onKey, true); return; }
            var win = self.getWindow && self.getWindow(), wn = win && win.renderContext().morphNode;
            if (!wn || !wn.contains(e.target)) return;
            self._onKeyDown(e);
          };
          document.addEventListener("keydown", this._onKey, true);
          this._onDocClick = function (e) {
            if (!self.world()) { document.removeEventListener("click", self._onDocClick, true); return; }
            if (self._menu && !e.target.closest(".mf-pop") && !self._root.contains(e.target)) { self._menu = null; self._renderPop(); }
          };
          document.addEventListener("click", this._onDocClick, true);
          // Ctrl-click and Shift-click choose more than one file here; the world would take the same press to select the morph under
          // it (a halo that then covers the window). It is kept from seeing a modified press inside this window's content. The click
          // that follows is a separate event and still arrives.
          this._onDown = function (e) {
            if (!self.world()) { window.removeEventListener("mousedown", self._onDown, true); window.removeEventListener("pointerdown", self._onDown, true); return; }
            if ((e.ctrlKey || e.shiftKey || e.metaKey || e.button === 2) && self._root.contains(e.target)) e.stopPropagation();
          };
          window.addEventListener("mousedown", this._onDown, true);
          window.addEventListener("pointerdown", this._onDown, true);
          // A file added, pointed at, renamed, moved or removed anywhere in this world tells the window. remove() runs whenever the
          // window is taken out of the world, which also happens when it is brought forward (taken out and put back at once), so
          // the listeners cannot be dropped there: a window that is really closed is not in the world when the next event comes.
          this._onChanged = function () {
            if (!self.world()) { window.removeEventListener("keo-files-changed", self._onChanged); return; }
            self.load();
          };
          window.addEventListener("keo-files-changed", this._onChanged);
          // A small picture became ready: put it in place of the icon without drawing the list again (a click in progress, the scroll
          // position and a name being typed are left alone).
          this._onThumb = function (e) {
            if (!self.world()) { window.removeEventListener("keo-thumb", self._onThumb); return; }
            self._showThumb(e.detail.id, e.detail.url);
          };
          window.addEventListener("keo-thumb", this._onThumb);
        },

        _onClick: function (e) {
          var self = this, a = e.target.closest("[data-act]"), row = e.target.closest(".mf-row");
          var act = a && a.getAttribute("data-act"), id = row && row.getAttribute("data-id");
          if (this._menu && !e.target.closest(".mf-pop")) { this._menu = null; this._renderPop(); }
          if (e.target.closest("input")) return;
          if (this._renaming != null && !this.finishRename(true)) return;
          if (this._folderEdit) { var fe = this._els.side.querySelector("input"); this.commitFolder(fe ? fe.value : ""); }
          if (!a && row) return this._select(id, e);
          if (!a) { if (e.target.closest(".mf-list")) { this._sel = []; this._last = null; this._renderSel(); this._renderList(); this._renderPrev(); } return; }
          var ids;
          switch (act) {
            case "loc": this._loc = a.getAttribute("data-loc"); this._sel = []; this._status = null; this._shown = this._pageSize; this._renderSide(); this.load(); break;
            case "view": this._view = a.getAttribute("data-view") === "grid" ? "grid" : "list"; this._renderBar(); this._renderList(); break;
            case "kind": this._kind = a.getAttribute("data-kind"); this._status = null; this._shown = this._pageSize; this._renderKinds(); this.load(); break;
            case "chk": e.stopPropagation(); this._toggle(id); break;
            // The second click of a double-click: counted by the browser (a "dblclick" event can be lost when the first click already
            // redrew the list under the pointer).
            case "name": if (e.detail >= 2 && !e.shiftKey && !e.ctrlKey && !e.metaKey) this.startRename(id); else this._select(id, e); break;
            case "more": ids = this._sel.indexOf(id) >= 0 ? this._sel.slice() : [id]; if (this._sel.indexOf(id) < 0) { this._sel = [id]; this._last = id; this._renderSel(); this._renderList(); this._renderPrev(); } this._openMenu("file", e, ids); break;
            case "place": this.place(this._sel.slice()); break;
            case "prename": this.startRename(this._sel[0]); break;
            case "pmove": case "selmove": this._openMenu("move", e, this._sel.slice()); break;
            case "remove": case "selremove": this._menu = null; this.removeFiles(this._sel.slice()); break;
            case "clear": this._sel = []; this._last = null; this._renderSel(); this._renderList(); this._renderPrev(); break;
            case "repoint": this._menu = null; this.pointToFile(); break;
            case "point": this.pointToFile(); break;
            case "phone": lively.require("lively.identity.PhoneDialog").toRun(function () { var open = $world.get("IdentityPhoneDialog"); if (open) open.comeForward(); else lively.BuildSpec("lively.identity.PhoneDialog").createMorph().openInWorldCenter(); }); break;
            case "newfolder": this._folderEdit = { id: null }; this._menu = null; this._renderSide(); this._renderPop(); break;
            case "more-files": this._shown += this._pageSize; this.load(); break;
            case "undo": var u = this._status && this._status.undo; this._status = null; this._renderStatus(); if (u) u(); break;
            case "mplace": ids = this._menu.ids; this._menu = null; this._renderPop(); this.place(ids); break;
            case "mrename": ids = this._menu.ids; this._menu = null; this._renderPop(); this.startRename(ids[0]); break;
            case "msave": ids = this._menu.ids; this._menu = null; this._renderPop(); this.saveCopy(ids[0]); break;
            case "mshow": ids = this._menu.ids; this._menu = null; this._renderPop(); this.showOnComputer(ids[0]); break;
            case "mmove": ids = this._menu.ids; this._menu = null; this._renderPop(); this._openMenu("move", e, ids); break;
            case "mremove": ids = this._menu.ids; this._menu = null; this._renderPop(); this.removeFiles(ids); break;
            case "move-to": ids = this._menu.ids; this._menu = null; this._renderPop(); this.moveFiles(ids, a.getAttribute("data-target")); break;
            case "frename": var fid = this._menu.folder; this._menu = null; this._renderPop(); this._folderEdit = { id: fid }; this._renderSide(); break;
            case "fdelete": var f = this._folderById(this._menu.folder); this._menu = null; this._renderPop(); if (f) this.deleteFolder(f); break;
          }
          void self;
        },

        _onKeyDown: function (e) {
          var t = e.target;
          if (t && t.matches && t.matches(".mf-rename")) {
            if (e.key === "Enter") { e.preventDefault(); this.finishRename(true); } else if (e.key === "Escape") { e.preventDefault(); this.finishRename(false); }
            return;
          }
          if (t && t.closest && t.closest(".mf-loc") && t.tagName === "INPUT") {
            if (e.key === "Enter") { e.preventDefault(); this.commitFolder(t.value); } else if (e.key === "Escape") { e.preventDefault(); this._folderEdit = null; this._renderSide(); }
            return;
          }
          if (t && t.closest && t.closest(".mf-pop") && t.tagName === "INPUT") {
            if (e.key === "Enter" && t.value.trim()) { e.preventDefault(); this._newFolderFromMenu(t.value.trim()); } else if (e.key === "Escape") { e.preventDefault(); this._menu = null; this._renderPop(); }
            return;
          }
          if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
          if (e.key === "F2" && this._sel.length === 1) { e.preventDefault(); this.startRename(this._sel[0]); }
          else if (e.key === "Escape") { if (this._menu) { this._menu = null; this._renderPop(); } else { this._sel = []; this._renderSel(); this._renderList(); this._renderPrev(); } }
          else if (e.key === "Delete" && this._sel.length) { e.preventDefault(); this.removeFiles(this._sel.slice()); }
        },

        _select: function (id, e) {
          var order = this._items.map(function (f) { return f.id; });
          if (e.shiftKey && this._last != null && order.indexOf(this._last) >= 0) {
            var a = order.indexOf(this._last), b = order.indexOf(id);
            this._sel = order.slice(Math.min(a, b), Math.max(a, b) + 1);
          } else if (e.ctrlKey || e.metaKey) { return this._toggle(id); }
          else {
            // the one file that is already chosen, chosen again: nothing changes, and the card is not redrawn under the pointer
            if (this._sel.length === 1 && this._sel[0] === id) return;
            this._sel = [id]; this._last = id;
          }
          this._status = null;
          this._renderAfterSelection();
        },

        _toggle: function (id) {
          var i = this._sel.indexOf(id);
          if (i >= 0) this._sel.splice(i, 1); else this._sel.push(id);
          this._last = id; this._status = null;
          this._renderAfterSelection();
        },

        _renderAfterSelection: function () { this._renderSel(); this._renderList(); this._renderPrev(); this._renderStatus(); },

        // Dropping a file card on a folder. The world takes dragover and drop first and hands them to the morph under the pointer
        // when it defines these two, so the folder under the pointer is found here, from the page's own element at that point.
        onHTML5Drag: function (evt) {
          if (!this._drag) return false;
          var t = this._dropAt(evt.clientX, evt.clientY);
          if (this._over && (!t || this._over !== t)) { this._over.classList.remove("over"); this._over = null; }
          if (!t) return false;
          evt.preventDefault();
          t.classList.add("over"); this._over = t;
          return true;
        },

        onHTML5Drop: function (evt) {
          var t = this._dropAt(evt.clientX, evt.clientY), ids = this._drag;
          if (this._over) { this._over.classList.remove("over"); this._over = null; }
          this._drag = null;
          if (!t || !ids) return false;
          evt.preventDefault();
          this.moveFiles(ids, t.getAttribute("data-drop"));
          return true;
        },

        _dropAt: function (x, y) {
          var el = document.elementFromPoint(x, y);
          var t = el && el.closest && el.closest("[data-drop]");
          return t && this._root.contains(t) ? t : null;
        },

        _endDrag: function () {
          this._drag = null;
          Array.prototype.forEach.call(this._root.querySelectorAll(".dragging, .over"), function (n) { n.classList.remove("dragging"); n.classList.remove("over"); });
        }
      },

      "reading the library", {

        // Every answer carries the number of the request that asked for it; one that is no longer the latest (the person typed on,
        // changed the filter, or something else changed the library) is dropped.
        load: function () {
          var self = this, seq = this._seq = (this._seq || 0) + 1;
          var args = { query: (this._query || "").trim(), type: this._kind || "", sort: this._sort, limit: this._shown, offset: 0 };
          if (this._loc !== "all") args.folder = this._loc;
          lf().search(args, function (err, r) {
            if (seq !== self._seq || !self.world()) return;
            if (err && self._loc !== "all" && /folder is not there|not a valid folder/.test(err.message || "")) { self._loc = "all"; return self.load(); }
            if (err) { self._items = []; self._total = 0; self._renderAll(); return self._say("Could not load your files: " + (err.message || err), true); }
            lf().folders(function (err2, fl) {
              if (seq !== self._seq || !self.world()) return;
              self._items = r.items || [];
              self._total = r.total || 0;
              self._unreadable = r.unreadable || 0;
              if (!err2 && fl) self._folders = fl;
              var ids = self._items.map(function (i) { return i.id; });
              self._sel = self._sel.filter(function (id) { return ids.indexOf(id) >= 0; });
              if (self._renaming != null && ids.indexOf(self._renaming) < 0) self._renaming = null;
              // Nothing the window shows has changed (the library said "changed" for something that is not on this screen, or for
              // what this window itself just did and already shows): leave the page as it is, so a click in progress, the scroll
              // position and a field being typed into are not disturbed.
              var sig = JSON.stringify([r, fl, self._loc, self._kind, self._sort, self._sel, self._renaming, self._pointState]);
              if (sig === self._sig) { self._checkPointed(); self._refreshSpace(); return; }
              self._sig = sig;
              self._renderAll();
              self._checkPointed();
              self._refreshSpace();
            });
          });
        },

        // Files kept where they lie: ask the shell whether each is still as it was. Asked again at every reading of the library (a
        // file can be moved away or put back while the window is open), and the page is drawn again only when an answer differs from
        // the one it shows.
        _checkPointed: function () {
          var self = this;
          this._items.forEach(function (it) {
            if (!it.pointed || (self._pointBusy && self._pointBusy[it.id])) return;
            (self._pointBusy = self._pointBusy || {})[it.id] = true;
            lf().info(it.id, function (err, info) {
              delete self._pointBusy[it.id];
              if (err || !info || !self.world()) return;
              var st = info.state || "ok";
              if (self._pointState[it.id] === st) return;
              self._pointState[it.id] = st;
              self._renderList(); self._renderPrev();
            });
          });
        },

        _refreshSpace: function () {
          var self = this, li = lively.identity.localIdentity;
          if (!li || typeof li.libSpace !== "function") return;
          li.libSpace(function (err, sp) {
            if (err || !self.world()) return;
            var files = sp.files > 0 ? lf().sizeText(sp.files, false) + " stored in keo" : "";
            var room = typeof sp.free === "number" ? (sp.free > 0 ? "room for about " + lf().sizeText(sp.free, true) + " more" : "no room left for more") : "";
            self._spaceText = [files, room].filter(Boolean).join("  ·  ");
            self._renderStatus();
          });
        },

        // When a field that had the keyboard is taken away (a name kept or given up) the focus would fall to the page and F2, Delete and
        // Esc would stop working: put it back on the window.
        _refocus: function () {
          var win = this.getWindow && this.getWindow(), n = win && win.renderContext().morphNode;
          if (n && n.focus) n.focus({ preventScroll: true });
        },

        _folderById: function (id) { return this._folders.folders.filter(function (f) { return f.id === id; })[0] || null; },
        _folderPath: function (id) {
          var f = this._folderById(id);
          if (!f) return "Unsorted";
          var p = f.parent && this._folderById(f.parent);
          return p ? p.name + " / " + f.name : f.name;
        },
        _item: function (id) { return this._items.filter(function (i) { return i.id === id; })[0] || null; },
        _say: function (text, err, undo) { this._status = { text: text, err: !!err, undo: undo || null }; this._renderStatus(); }
      },

      "rendering", {

        _renderAll: function () { this._renderBar(); this._renderKinds(); this._renderSide(); this._renderSel(); this._renderList(); this._renderPrev(); this._renderStatus(); this._renderPop(); },

        _renderBar: function () {
          var els = this._els;
          els.sort.value = this._sort;
          var v = this._view;
          els.view.innerHTML =
            '<button data-act="view" data-view="list" title="List" aria-label="List" aria-pressed="' + (v !== "grid") + '"><span class="mf-ms">view_list</span></button>' +
            '<button data-act="view" data-view="grid" title="Grid with small pictures" aria-label="Grid" aria-pressed="' + (v === "grid") + '"><span class="mf-ms">grid_view</span></button>';
          els.point.innerHTML = (lf().pointAvailable
            ? '<button class="mf-point" data-act="point"><span class="mf-ms">attach_file</span>Point to a file</button>' : "") +
            (lively.identity.localIdentity.phoneReady
              ? '<button class="mf-point mf-pill" data-act="phone" title="Receive files from a phone on the same Wi-Fi"><span class="mf-ms">bolt</span>WarpDrop</button>' : "");
        },

        _renderKinds: function () {
          var kind = this._kind;
          this._els.kinds.innerHTML = KINDS.map(function (k) {
            return '<button data-act="kind" data-kind="' + esc(k.type) + '" aria-pressed="' + (kind === k.type) + '">' + k.label + "</button>";
          }).join("");
        },

        _renderSide: function () {
          var self = this, fl = this._folders, loc = this._loc, edit = this._folderEdit;
          function mk(id, icon, label, n, extra) {
            if (edit && edit.id && edit.id === id) {
              return '<div class="mf-loc on" data-folder="' + esc(id) + '"><span class="mf-ms">' + icon + '</span><input value="' + esc(label) + '" aria-label="Folder name"></div>';
            }
            return '<div class="mf-loc' + (loc === id ? " on" : "") + '" data-act="loc" data-loc="' + esc(id) + '"' + (extra || "") + '><span class="mf-ms">' + icon +
              '</span><span class="mf-nm">' + esc(label) + '</span><span class="mf-n">' + n + "</span></div>";
          }
          var rows = [mk("all", "folder_open", "All files", fl.all), mk("unsorted", "inbox", "Unsorted", fl.unsorted, ' data-drop="unsorted"')];
          function walk(parent, depth) {
            fl.folders.filter(function (f) { return f.parent === parent; }).forEach(function (f) {
              var html = mk(f.id, "folder", f.name, f.total, ' data-drop="' + esc(f.id) + '" data-folder="' + esc(f.id) + '"');
              rows.push(depth ? html.replace('class="mf-loc', 'style="margin-left:' + depth * 14 + 'px" class="mf-loc') : html);
              walk(f.id, depth + 1);
            });
          }
          walk(null, 0);
          if (edit && !edit.id) rows.push('<div class="mf-loc on"><span class="mf-ms">folder</span><input placeholder="Folder name" aria-label="New folder name"></div>');
          this._els.side.innerHTML = '<div class="mf-sh"><span>Folders</span><button data-act="newfolder" title="New folder" aria-label="New folder"><span class="mf-ms">create_new_folder</span></button></div>' + rows.join("");
          var inp = this._els.side.querySelector("input");
          if (inp) { inp.focus(); inp.select(); }
          void self;
        },

        _renderSel: function () {
          var n = this._sel.length, el = this._els.sel;
          el.innerHTML = n > 1
            ? '<div class="mf-selbar"><span>' + plural(n, "file") + ' selected</span><button data-act="selmove">Move to …</button><button data-act="place">Place in world</button><button data-act="selremove">Remove …</button><button class="mf-clr" data-act="clear">Clear</button></div>'
            : "";
          this._root.classList.toggle("mf-anysel", n > 0);
        },

        _meta: function (it) {
          var bits = [esc(typeWord(it)), esc(lf().sizeText(it.size, false)), "added " + esc(ago(it.created))], out;
          if (it.pointed) bits.push("stored on this computer");
          out = bits.join("  ·  ");
          var w = { missing: "file missing", changed: "file changed", denied: "cannot open file" }[this._pointState[it.id]];
          if (w) out += '  ·  <span class="mf-bad">' + w + "</span>";
          if (it.folder && this._loc === "all") out += "  ·  in " + esc(this._folderPath(it.folder));
          return out;
        },

        _renderList: function () {
          var self = this, el = this._els.list, items = this._items, keepTop = el.scrollTop;
          if (!items.length) {
            var q = (this._query || "").trim(), asked = q || this._kind;
            var canPoint = !!lf().pointAvailable;
            el.innerHTML = '<div class="mf-empty"><span class="mf-ms">' + (asked ? "search_off" : "folder_open") + "</span>" + (asked ? "No file matches."
              : this._loc === "all" ? "No files yet. Drop a picture, video, audio or document onto a world" + (canPoint ? ", or choose Point to a file." : ".")
              : "Nothing here yet. Drag files onto this folder or use Move to …") + "</div>";
            return;
          }
          var grid = this._view === "grid";
          el.className = "mf-list" + (grid ? " mf-grid" : "");
          var html = items.map(function (it) {
            var sel = self._sel.indexOf(it.id) >= 0, name, thumb = lf().thumbUrl(it.id);
            if (self._renaming === it.id) {
              var p = splitName(it.name);
              name = '<div class="mf-nmx"><input class="mf-rename" value="' + esc(p.base) + '" aria-label="File name">' + (p.ext ? '<span class="mf-ext">.' + esc(p.ext) + "</span>" : "") + "</div>";
            } else name = '<div class="mf-nmx" data-act="name" title="' + esc(it.name) + '">' + nameHtml(it) + "</div>";
            var more = '<button class="mf-act" data-act="more" title="More" aria-label="More"><span class="mf-ms">more_horiz</span></button>';
            if (grid) {
              return '<div class="mf-row mf-tile' + (sel ? " sel" : "") + '" draggable="true" data-id="' + esc(it.id) + '">' +
                '<div class="mf-th" data-el="tile">' + (thumb ? '<img alt="" draggable="false" src="' + thumb + '">' : '<span class="mf-ms">' + iconFor(it) + "</span>") + "</div>" +
                '<button class="mf-chk" data-act="chk" aria-label="Select"><span class="mf-ms">check</span></button>' + more +
                '<div class="mf-txt">' + name + '<div class="mf-meta">' + esc(typeWord(it)) + "  ·  " + esc(lf().sizeText(it.size, false)) + "</div></div></div>";
            }
            return '<div class="mf-row' + (sel ? " sel" : "") + '" draggable="true" data-id="' + esc(it.id) + '">' +
              '<div class="mf-lead' + (thumb ? " mf-has" : "") + '">' + (thumb ? '<img class="mf-timg" alt="" draggable="false" src="' + thumb + '">' : '<span class="mf-ms mf-kind">' + iconFor(it) + "</span>") +
              '<button class="mf-chk" data-act="chk" aria-label="Select"><span class="mf-ms">check</span></button></div>' +
              '<div class="mf-txt">' + name + '<div class="mf-meta">' + self._meta(it) + "</div></div>" + more + "</div>";
          }).join("");
          if (this._total > items.length) html += '<button class="mf-more" data-act="more-files">Show more (' + (this._total - items.length) + " more)</button>";
          el.innerHTML = html;
          el.scrollTop = keepTop;
          var r = el.querySelector(".mf-rename");
          if (r) { r.focus(); r.select(); }
          lf().ensureThumbs(items);          // a picture without its small picture yet gets one; each is put in place when it is ready
        },

        // A small picture is ready: swap it for the icon of that file wherever it is drawn (list row or tile).
        _showThumb: function (id, url) {
          var rows = this._els && this._els.list ? this._els.list.querySelectorAll(".mf-row") : [];
          Array.prototype.forEach.call(rows, function (row) {
            if (row.getAttribute("data-id") !== id) return;
            var lead = row.querySelector(".mf-lead"), th = row.querySelector('[data-el="tile"]');
            if (th) th.innerHTML = '<img alt="" draggable="false" src="' + url + '">';
            else if (lead && !lead.querySelector(".mf-timg")) {
              var k = lead.querySelector(".mf-kind");
              if (k) k.parentNode.removeChild(k);
              lead.classList.add("mf-has");
              var img = document.createElement("img");
              img.className = "mf-timg"; img.alt = ""; img.draggable = false; img.src = url;
              lead.insertBefore(img, lead.firstChild);
            }
          });
          // A selected file that is not a picture is shown in the preview as its small picture, as soon as that is ready.
          if (this._sel.length === 1 && this._sel[0] === id && this._els.prev) {
            var pth = this._els.prev.querySelector('[data-el="thumb"]');
            if (pth && !pth.querySelector("img")) pth.innerHTML = '<img alt="" src="' + url + '">';
          }
        },

        _renderPrev: function () {
          var el = this._els.prev;
          if (this._thumbUrl) { try { URL.revokeObjectURL(this._thumbUrl); } catch (e) { /* gone already */ } this._thumbUrl = null; }
          if (this._sel.length !== 1) {
            el.innerHTML = this._sel.length > 1
              ? '<div class="mf-pempty"><span class="mf-ms">library_add_check</span>' + plural(this._sel.length, "file") + " selected.<br>Use the strip above the list.</div>"
              : '<div class="mf-pempty"><span class="mf-ms">preview</span>Select a file to see it here.</div>';
            return;
          }
          var it = this._item(this._sel[0]);
          if (!it) { el.innerHTML = ""; return; }
          var st = this._pointState[it.id], bad = { missing: "file missing", changed: "file changed", denied: "cannot open file" }[st];
          el.innerHTML = '<div class="mf-th" data-el="thumb"><span class="mf-ms">' + iconFor(it) + "</span></div>" +
            '<div class="mf-pn"><div class="mf-t">' + nameHtml(it) + '</div><button class="mf-act" data-act="prename" title="Rename" aria-label="Rename"><span class="mf-ms">edit</span></button></div>' +
            "<dl><dt>Type</dt><dd>" + esc(typeWord(it)) + "</dd><dt>Size</dt><dd>" + esc(lf().sizeText(it.size, false)) + "</dd><dt>Added</dt><dd>" + esc(ago(it.created)) + "</dd>" +
            '<dt>Folder</dt><dd><button class="mf-lnk" data-act="pmove">' + esc(this._folderPath(it.folder)) + " ▾</button></dd>" +
            "<dt>Stored</dt><dd>" + (it.pointed ? "On this computer, not copied" + (bad ? ' <span class="mf-bad" style="color:#c0392b">(' + bad.replace("file ", "") + ")</span>" : "") : "Inside keo") + "</dd>" +
            '<dt>Used in</dt><dd data-el="usedin">checking …</dd></dl>' +
            '<div class="mf-pbtns"><button class="mf-primary" data-act="place"' + (st === "missing" ? " disabled" : "") + '><span class="mf-ms">add_photo_alternate</span>Place in world</button>' +
            (it.pointed && (st === "missing" || st === "changed" || st === "denied") && lf().pointAvailable ? '<button class="mf-line" data-act="repoint">Point to it again …</button>' : "") +
            '<button class="mf-line" data-act="remove">' + (it.pointed ? "Stop using this file …" : "Remove from library …") + "</button></div>";
          // A picture is drawn as it is (if it is not large: it is read whole to do that).
          if (/^image\//.test(it.type) && it.size <= MAX_THUMB && !bad) {
            var self = this, id = it.id;
            lf().blobFor(id, function (err, blob) {
              if (err || !self.world() || self._sel.length !== 1 || self._sel[0] !== id) return;
              var th = self._els.prev.querySelector('[data-el="thumb"]');
              if (!th) return;
              self._thumbUrl = URL.createObjectURL(blob);
              th.innerHTML = '<img alt="" src="' + self._thumbUrl + '">';
            });
          } else if (lf().thumbUrl(it.id)) {
            // A video, a PDF or a book: its small picture, if it has one already (_showThumb adds it later otherwise).
            var tu = lf().thumbUrl(it.id), th2 = this._els.prev.querySelector('[data-el="thumb"]');
            if (th2) th2.innerHTML = '<img alt="" src="' + tu + '">';
          }
          this._fillUsedIn(it.id);
        },

        // "Used in": the saved worlds that show the file, found by the shell (it reads each world saved since it last looked, once), and the
        // world that is open now if it shows the file and is not saved yet.
        _fillUsedIn: function (id) {
          var self = this;
          lf().usedIn([id], function (err, res) {
            if (!self.world() || self._sel.length !== 1 || self._sel[0] !== id) return;
            var dd = self._els.prev.querySelector('[data-el="usedin"]');
            if (dd) dd.innerHTML = err ? "not known" : self._usedLine(id, res);
          });
        },
        _openWorldName: function () { return window.keo && window.keo.init && window.keo.init.startup ? window.keo.init.startup.name || null : null; },
        _usedLine: function (id, res) {
          var names = (res && res[id]) || [], shown = names.slice(0, 4), list = shown.map(esc);
          if (names.length > shown.length) list.push("and " + (names.length - shown.length) + " more");
          if (lf().worldHolds(id) && names.indexOf(this._openWorldName()) < 0) list.push("this world (not saved yet)");
          var out = list.length ? list.join(", ") : "No saved world";
          if (res && res._unreadable) out += " (" + plural(res._unreadable, "saved world") + " could not be read)";
          return out;
        },
        // A sentence for the question before a removal: which worlds show these files. "" when none does (the question is then as it was).
        _usedSentence: function (its, res) {
          var worlds = [], self = this, open = false;
          its.forEach(function (i) {
            ((res && res[i.id]) || []).forEach(function (n) { if (worlds.indexOf(n) < 0) worlds.push(n); });
            if (lf().worldHolds(i.id) && ((res && res[i.id]) || []).indexOf(self._openWorldName()) < 0) open = true;
          });
          var parts = worlds.slice(0, 4);
          if (worlds.length > parts.length) parts.push("and " + (worlds.length - parts.length) + " more");
          if (open) parts.push("this world (not saved yet)");
          if (!parts.length) return "";
          var what = its.length === 1 ? "“" + its[0].name + "” is" : "These " + its.length + " files are";
          return what + " shown in " + (worlds.length ? plural(worlds.length, "saved world") + ": " : "") + parts.join(", ") + ".";
        },

        _renderStatus: function () {
          var s = this._status, el = this._els.status;
          el.className = "mf-status" + (s && s.err ? " err" : "");
          var text;
          if (s) text = esc(s.text);
          else if (this._unreadable) text = esc(plural(this._unreadable, "file") + " could not be read and " + (this._unreadable === 1 ? "is" : "are") + " not listed.");
          else text = esc([plural(this._total, "file") + (this._loc === "all" && !this._query && !this._kind ? "" : " shown"), this._spaceText].filter(Boolean).join("  ·  "));
          el.innerHTML = "<span>" + text + "</span>" + (s && s.undo ? '<button data-act="undo">Undo</button>' : "");
          if (!s && this._unreadable) el.className = "mf-status err";
        },

        // The menus: a small list at the pointer, inside the window.
        _openMenu: function (type, e, ids, extra) {
          var r = this._root.getBoundingClientRect();
          var x = Math.min(e.clientX - r.left, r.width - 230), y = Math.min(e.clientY - r.top, r.height - (type === "move" ? 250 : 150));
          this._menu = { type: type, x: Math.max(4, x), y: Math.max(4, y), ids: ids };
          for (var k in (extra || {})) this._menu[k] = extra[k];
          e.stopPropagation();
          this._renderPop();
        },

        _renderPop: function () {
          var m = this._menu, el = this._els.pop, h = "";
          if (!m) { el.innerHTML = ""; return; }
          var self = this;
          function it(label, act, extra) { return '<div class="mf-it" data-act="' + act + '"' + (extra || "") + ">" + label + "</div>"; }
          if (m.type === "file") {
            var one = m.ids.length === 1, n = m.ids.length, f = one && this._item(m.ids[0]);
            h += it(one ? "Place in world" : "Place " + n + " files in world", "mplace");
            if (one) h += it("Rename …", "mrename");
            if (one) h += it("Save a copy to this computer", "msave");
            if (one && f && f.pointed && lf().pointAvailable) h += it("Show on this computer", "mshow");      // only a file kept where it lies has a place to show
            h += it(one ? "Move to …" : "Move " + n + " files to …", "mmove");
            h += it(one ? (f && f.pointed ? "Stop using this file …" : "Remove from library …") : "Remove " + n + " files …", "mremove");
          } else if (m.type === "folder") {
            h += it("Rename folder …", "frename") + it("Delete folder …", "fdelete") + '<div class="mf-hint">Its files are not deleted. They go to the folder above, or to Unsorted.</div>';
          } else if (m.type === "move") {
            var cur = m.ids.length === 1 ? (this._item(m.ids[0]) || {}).folder || null : undefined;
            h += '<div class="mf-hd">Move ' + (m.ids.length === 1 ? "to" : plural(m.ids.length, "file") + " to") + "</div>";
            h += '<div class="mf-it" data-act="move-to" data-target="unsorted"><span class="mf-ms">' + (cur === null ? "check" : "inbox") + "</span>Unsorted</div>";
            (function walk(parent, depth) {
              self._folders.folders.filter(function (f) { return f.parent === parent; }).forEach(function (f) {
                h += '<div class="mf-it" style="padding-left:' + (12 + depth * 14) + 'px" data-act="move-to" data-target="' + esc(f.id) + '"><span class="mf-ms">' + (cur === f.id ? "check" : "folder") + "</span>" + esc(f.name) + "</div>";
                walk(f.id, depth + 1);
              });
            })(null, 0);
            h += '<div class="mf-sep"></div><div class="mf-newrow"><input placeholder="New folder …" aria-label="New folder"></div>';
          }
          el.innerHTML = '<div class="mf-pop" style="left:' + m.x + "px;top:" + m.y + 'px">' + h + "</div>";
          var inp = el.querySelector("input");
          if (inp) inp.focus();
        }
      },

      "what a person can do", {

        // Hands a copy of the file to the browser as a download (the shell makes it). Where it goes is the browser's choice, so the line
        // says only that it was sent.
        saveCopy: function (id) {
          var self = this, it = this._item(id);
          if (!it) return;
          this._say("Saving a copy of " + it.name + " …");
          lf().save(id, function (err) {
            if (err) return self._say("Could not save a copy: " + String(err.message || err), true);
            self._say("A copy of " + it.name + " was sent to your browser's downloads.");
          });
        },

        // A file kept where it lies, shown in its folder by the computer's own file manager (the app does it; this window is never told where).
        showOnComputer: function (id) {
          var self = this, it = this._item(id);
          if (!it) return;
          lf().show(id, function (err) {
            if (err) return self._say("Could not show it: " + String(err.message || err), true);
            self._say("Showing " + it.name + " on this computer.");
          });
        },

        startRename: function (id) {
          var it = this._item(id);
          if (!it) return;
          this._renaming = id; this._menu = null; this._sel = [id]; this._last = id;
          this._say(it.pointed ? "Renaming only changes the name in keo. The file on your computer keeps its own name." : "Enter keeps the new name. Esc keeps the old one.");
          this._renderSel(); this._renderList(); this._renderPrev(); this._renderPop();
        },

        // Returns false when the name was refused and the field stays open.
        finishRename: function (commit) {
          var self = this, id = this._renaming;
          if (id == null) return true;
          var input = this._els.list.querySelector(".mf-rename"), it = this._item(id);
          if (!commit || !input || !it) { this._renaming = null; this._status = null; this._renderList(); this._renderStatus(); this._refocus(); return true; }
          var v = input.value.trim().replace(/\s+/g, " ");
          if (!v) { this._say("A name needs at least one letter or digit. Esc keeps the old one.", true); input.focus(); return false; }
          if (/[\\/:*?"<>|]/.test(v)) { this._say("A name cannot hold any of  \\ / : * ? \" < > |", true); input.focus(); return false; }
          var p = splitName(it.name), full = v + (p.ext ? "." + p.ext : ""), old = it.name;
          this._renaming = null;
          if (full === old) { this._status = null; this._renderList(); this._renderStatus(); this._refocus(); return true; }
          lf().rename(id, full, function (err, r) {
            if (!self.world()) return;
            if (err) return self._say(err.message || String(err), true);
            self._say("Renamed to " + r.name + "." + (r.same ? " Another file here has the same name." : ""), false, function () {
              lf().rename(id, old, function (e2) { if (self.world()) self._say(e2 ? (e2.message || String(e2)) : "Undone.", !!e2); });
            });
          });
          this._renderList(); this._refocus();
          return true;
        },

        moveFiles: function (ids, target, folderName) {
          var self = this, before = ids.map(function (id) { var it = self._item(id); return [id, it ? it.folder : null]; });
          var name = target === "unsorted" ? "Unsorted" : folderName || (this._folderById(target) || {}).name || "that folder";
          lf().move(ids, target, function (err, r) {
            if (!self.world()) return;
            if (err) return self._say(err.message || String(err), true);
            self._say((r.moved ? "Moved " + plural(r.moved, "file") + " to " + name + "." : "Already in " + name + ".") + (r.missing ? " " + plural(r.missing, "file") + " could not be moved." : ""), false, r.moved ? function () {
              var groups = {};
              before.forEach(function (b) { var k = b[1] || "unsorted"; (groups[k] = groups[k] || []).push(b[0]); });
              (function next(keys) {
                if (!keys.length) return self.world() && self._say("Undone.");
                lf().move(groups[keys[0]], keys[0], function () { next(keys.slice(1)); });
              })(Object.keys(groups));
            } : null);
          });
        },

        // From the move menu: a folder is made (inside the folder being looked at when that is a top-level one is NOT assumed here:
        // always at the top level), and the files go into it.
        _newFolderFromMenu: function (name) {
          var self = this, ids = this._menu.ids;
          this._menu = null; this._renderPop();
          lf().folderCreate(name, null, function (err, f) {
            if (!self.world()) return;
            if (err) return self._say(err.message || String(err), true);
            self.moveFiles(ids, f.id, f.name);
          });
        },

        // The name typed into the folders panel: a new folder (inside the one being looked at when that is a top-level folder) or a
        // new name for an existing one.
        commitFolder: function (v) {
          var self = this, fe = this._folderEdit;
          v = String(v || "").trim();
          this._folderEdit = null;
          if (!v || !fe) { this._renderSide(); return this._refocus(); }
          this._refocus();
          if (fe.id) {
            lf().folderRename(fe.id, v, function (err) {
              if (!self.world()) return;
              self._say(err ? (err.message || String(err)) : "Renamed the folder to " + v + ".", !!err);
              self._renderSide();
            });
          } else {
            var cur = this._loc !== "all" && this._loc !== "unsorted" ? this._folderById(this._loc) : null;
            var parent = cur && !cur.parent ? cur.id : null;
            lf().folderCreate(v, parent, function (err, f) {
              if (!self.world()) return;
              if (err) { self._say(err.message || String(err), true); return self._renderSide(); }
              self._loc = f.id; self._shown = self._pageSize;
              self._say("Made the folder " + f.name + (parent ? " inside " + cur.name : "") + ".");
              self.load();
            });
          }
        },

        deleteFolder: function (f) {
          var self = this;
          lf().folderDelete(f.id, function (err, r) {
            if (!self.world()) return;
            if (err) return self._say(err.message || String(err), true);
            if (self._loc === f.id) { self._loc = "all"; }
            var up = r.parent ? (self._folderById(r.parent) || {}).name : null;
            self._say("Deleted the folder " + f.name + ". Its " + plural(r.files, "file") + (r.files === 1 ? " is" : " are") + " now in " + (up || "Unsorted") + ".");
          });
        },

        // Puts the files in the world one after another.
        place: function (ids) {
          var self = this, its = ids.map(function (id) { return self._item(id); }).filter(Boolean);
          if (!its.length) return;
          var done = 0, failed = null;
          (function next() {
            if (!its.length || failed) {
              if (!self.world()) return;
              if (self._sel.length === 1) self._fillUsedIn(self._sel[0]);        // the chosen file may now be shown in the open world
              return failed ? self._say(failed.message || String(failed), true)
                : self._say(done === 1 ? "Placed “" + ids.map(function (id) { return (self._item(id) || {}).name; })[0] + "” in the world." : "Placed " + plural(done, "file") + " in the world.");
            }
            var it = its.shift();
            lively.data.FileUpload.placeLibraryFile({ name: it.name, type: it.type, size: it.size, ref: { handle: lf().HANDLE, objId: it.id, blobCid: it.id } }, function (err) {
              if (err) failed = err; else done++;
              next();
            });
          })();
        },

        removeFiles: function (ids) {
          var self = this, its = ids.map(function (id) { return self._item(id); }).filter(Boolean);
          if (!its.length) return;
          var one = its.length === 1, it = its[0], size = its.reduce(function (a, i) { return a + i.size; }, 0);
          var allPointed = its.every(function (i) { return i.pointed; });
          var text = one
            ? (it.pointed
              ? "Stop using “" + it.name + "”? The file on your computer is not deleted. Worlds that show it will not be able to show it any more."
              : "Remove “" + it.name + "” (" + lf().sizeText(it.size, false) + ") from your library? Worlds that show it will not be able to show it any more. This cannot be undone.")
            : (allPointed
              ? "Stop using these " + its.length + " files? The files on your computer are not deleted. Worlds that show them will not be able to show them any more."
              : "Remove these " + its.length + " files (" + lf().sizeText(size, false) + ") from your library? Worlds that show them will not be able to show them any more. This cannot be undone.");
          function ask(used) {
            if (self.world()) { self._status = null; self._renderStatus(); }
            $world.confirm((used ? used + " " : "") + text, function (yes) {
              if (!yes) return;
              var left = its.slice(), removed = 0, fail = null;
              (function next() {
                if (!left.length || fail) {
                  if (!self.world()) return;
                  return fail ? self._say(fail.message || String(fail), true) : self._say(one ? "Removed “" + it.name + "”." : "Removed " + plural(removed, "file") + ".");
                }
                lf().remove(left.shift().id, function (err) { if (err) fail = err; else removed++; next(); });
              })();
            });
          }
          // Which worlds show them is asked first, so the question can name them (if that cannot be found out, it is asked as it always was).
          this._say("Checking which worlds show " + (one ? "it" : "them") + " …");
          lf().usedIn(its.map(function (i) { return i.id; }), function (err, res) { ask(err ? "" : self._usedSentence(its, res)); });
        },

        // The desktop app only: the shell asks which file, and keeps it where it lies. The file is added to the list; "place" puts it in the world.
        pointToFile: function () {
          var self = this;
          lf().point(function (err, info) {
            if (!self.world()) return;
            if (err) return self._say(err.message || String(err), true);
            if (!info) return;
            if (info.existed && !info.pointed) return self._say("“" + info.name + "” is already in your library as a copy, which is kept.");
            self._say("Added “" + info.name + "”, stored where it is on this computer.");
          });
        }
      });

    // ── class-side entry point ───────────────────────────────────────────────────────────────────────────────────────────────
    Object.extend(lively.identity.MyFilesBrowser, {
      WINDOW_NAME: NAME,

      // One window at a time, found by name, like My worlds. Opens at 820 x 580, less on a screen that is smaller than that.
      open: function () {
        var open = $world.submorphs.filter(function (m) { return m.name === NAME; })[0];
        if (open) { open.comeForward(); return open; }
        ensureStyle();
        var vis = lively.morphic.World.current().visibleBounds();
        var w = Math.min(820, Math.max(560, vis.width - 40)), h = Math.min(580, Math.max(420, vis.height - 40));
        // the window adds its title bar and a thin frame around the content
        var view = new lively.identity.MyFilesBrowser(lively.rect(0, 0, w - 4, h - 23));
        view.setName("myFilesContent");
        view.openInWindow({ title: "My files", pos: vis.center().subPt(lively.pt(w / 2, h / 2)) });
        var win = view.getWindow();
        win.setName(NAME);
        win.addStyleClassName("myfiles-chrome");
        // Do NOT mark the window isEpiMorph to keep it out of a saved world: with that flag set the world re-attaches the window on
        // every mouse press, the press and the release then land on different elements, and no click ever happens (measured).
        // A window left open when a world is saved is rebuilt by onrestore instead.
        win.comeForward();
        return win;
      }
    });
  });
