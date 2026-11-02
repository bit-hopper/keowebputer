/**
 * lively.music.Music
 *
 * A personal music library: the fifth "world template" (see
 * core/lively/identity/WorldTemplateLauncher.js), following
 * lively.books.Books' architecture — a self-rendering morph that owns raw DOM
 * directly, _buildChrome()/_render* idiom. Albums are shelved, rated and
 * reviewed; playlists hold tracks and carry real Private/Shared/Public
 * visibility; 30-second previews play in-app.
 *
 * Storage:
 *   - One "Library" FileCrypto folder per owner (musicLibraryObjId /
 *     musicLibraryHandle, serialized Morph properties), always
 *     visibility:'public', indexing albums (refType:'album') and playlists
 *     (refType:'playlist') through addPointerToFolder.
 *   - An Album is its own small always-public envelope (type:'album',
 *     FileCrypto's createAlbum/fetchAlbum/updateAlbum/deleteAlbum) holding a
 *     snapshot taken at add-time: title/artist/year/cover/tracklist.
 *   - A Playlist is a real FileCrypto folder (createFolder / shareFolder /
 *     setFolderVisibility / revokeFolderRecipient). Its entries are inline
 *     track snapshots (type:'track'), appended in one write via
 *     addEntriesToFolder.
 *   - Reviews & Notes reuse the generic `/@:handle/:objId/comments` routes,
 *     keyed by the album's objId.
 *   - The library-level Public/Private switch is display privacy only (it
 *     hides shelves/ratings/reviews from visitors); it is a serialized morph
 *     property, not encryption.
 *
 * Catalog: a public catalog search API is called straight from the browser.
 * It throttles bursts with a CORS-less 403 that fetch() reports as a plain
 * network error, so every catalog call is paced and retried on ANY failure.
 *
 * Entry point:
 *   lively.music.Music.open(optWorldPosition)
 */

module("lively.music.Music")
  .requires("lively.music.PlaylistIO")
  .toRun(function () {
    var SHELF_KEYS = ["want", "listening", "listened", "dropped"];
    var SHELF_LABELS = { all: "All albums", want: "Want to listen", listening: "Listening", listened: "Listened", dropped: "Dropped" };
    var SHELF_ICONS = { all: "grid_view", want: "bookmark", listening: "headphones", listened: "check_circle", dropped: "remove_circle" };
    var VIS_LABEL = { private: "Private", shared: "Shared", public: "Public" };
    var VIS_ICON = { private: "lock", shared: "group", public: "public" };
    var VIS_COLOR = { private: "#f2a65a", shared: "#79b8ff", public: "#4fd69c" };
    var VIS_DESC = {
      private: "Only you. Encrypted, so a passkey touch may be needed to open it.",
      shared: "Only people you add can open it. Encrypted to each person.",
      public: "Anyone with the link can see it. Not encrypted.",
    };
    var COVER_PALETTE = [
      ["#e0784a", "#2b2a4a"], ["#1f3b4d", "#9ad1d4"], ["#2d1b4e", "#f2b134"], ["#6b8f4e", "#f4e4b8"],
      ["#b0245f", "#1a0f1e"], ["#2a6f97", "#e8f1f5"], ["#c98b3a", "#2e2118"], ["#0f6b6b", "#f3e9d2"],
    ];
    // Pasted-link "full track" player. Only music sources are accepted: the
    // pasted link's hostname must be one of EMBED_SOURCES (so arbitrary URLs
    // never reach the unfurl endpoint), and the embed URL the server returns
    // is re-checked against EMBED_HOSTS before it is ever set as an iframe src.
    var EMBED_SOURCES = {
      "open.spotify.com": 1, "youtube.com": 1, "www.youtube.com": 1, "m.youtube.com": 1, "music.youtube.com": 1,
      "youtu.be": 1, "soundcloud.com": 1, "www.soundcloud.com": 1, "music.apple.com": 1,
    };
    var EMBED_HOSTS = { "open.spotify.com": "audio", "www.youtube.com": "video", "w.soundcloud.com": "audio", "embed.music.apple.com": "audio" };
    var EMBED_PROVIDERS = ["spotify", "youtube", "soundcloud", "apple-music"];
    var CATALOG_SEARCH = "https://itunes.apple.com/search";
    var CATALOG_LOOKUP = "https://itunes.apple.com/lookup";

    var THEMES = {
      midnight: {
        label: "Midnight", swatch: "#b8a1ff",
        vars: { bg: "#0f0e14", side: "#15141c", surf: "#1c1b25", surf2: "#262532", line: "#34323f", text: "#f3f0f8", mute: "#b0abc0", faint: "#8d88a3", acc: "#b8a1ff", acc2: "#ffd166", onacc: "#16121f", accsoft: "#2c2644", scrim: "rgba(5,4,10,.66)" },
      },
      echo: {
        label: "Echo", swatch: "#d9087a",
        vars: { bg: "#fff3f9", side: "#ffe6f2", surf: "#ffffff", surf2: "#ffeaf4", line: "#f3b9d5", text: "#2b1220", mute: "#6f3f5b", faint: "#8c5a74", acc: "#d9087a", acc2: "#0f8f5e", onacc: "#ffffff", accsoft: "#ffd3e8", scrim: "rgba(60,10,40,.45)" },
      },
      paper: {
        label: "Paper", swatch: "#b83a1b",
        vars: { bg: "#f5f0e6", side: "#ece5d6", surf: "#fffdf8", surf2: "#f0e9da", line: "#d6cbb4", text: "#26221d", mute: "#5f5648", faint: "#766c5b", acc: "#b83a1b", acc2: "#2b7a74", onacc: "#ffffff", accsoft: "#f3d9ce", scrim: "rgba(40,30,15,.45)" },
      },
    };
    var THEME_KEYS = ["midnight", "echo", "paper"];

    function themeCssBlock(key) {
      var v = THEMES[key].vars;
      return '.lk-music-viewport[data-theme="' + key + '"] {' +
        Object.keys(v).map(function (k) { return " --" + k + ":" + v[k] + ";"; }).join("") + " }";
    }

    // Every rule is scoped under .lk-music-viewport so nothing leaks into the
    // rest of the Lively world. Theme custom properties live on the OUTER
    // viewport node because the modals are siblings of the scrolling main
    // pane, not descendants of it.
    var MUSIC_CSS = "" +
      "@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=DM+Sans:wght@400;500;600&family=DM+Mono&display=swap');" +
      THEME_KEYS.map(themeCssBlock).join("") +
      ".lk-music-viewport { position:relative; display:flex; flex-direction:column; height:100%; overflow:hidden; background:var(--bg); color:var(--text);" +
      "  font-family:'DM Sans',system-ui,sans-serif; font-size:14px; line-height:1.4; box-sizing:border-box; transition:background .2s ease, color .2s ease; }" +
      ".lk-music-viewport, .lk-music-viewport *, .lk-music-viewport *::before, .lk-music-viewport *::after { box-sizing:border-box; }" +
      ".lk-music-viewport button { font:inherit; color:inherit; cursor:pointer; border:0; background:none; padding:0; margin:0; }" +
      ".lk-music-viewport button:disabled { cursor:default; opacity:.45; }" +
      ".lk-music-viewport button.keep:disabled { opacity:1; }" +
      ".lk-music-viewport input, .lk-music-viewport textarea { font:inherit; font-size:14px; color:var(--text); background:var(--surf); border:1px solid var(--line); border-radius:10px; padding:10px 12px; outline:none; width:100%; }" +
      ".lk-music-viewport input::placeholder, .lk-music-viewport textarea::placeholder { color:var(--faint); }" +
      ".lk-music-viewport input:focus, .lk-music-viewport textarea:focus { border-color:var(--acc); box-shadow:0 0 0 3px var(--accsoft); }" +
      ".lk-music-viewport button:focus-visible { outline:2px solid var(--acc); outline-offset:2px; }" +
      ".lk-music-viewport .ms { font-family:'Material Symbols Rounded'; font-weight:normal; font-style:normal; line-height:1; letter-spacing:normal; text-transform:none; display:inline-block; white-space:nowrap; direction:ltr; -webkit-font-smoothing:antialiased; flex:none; }" +
      ".lk-music-viewport .display { font-family:'Bricolage Grotesque',system-ui,sans-serif; }" +
      ".lk-music-viewport .mono { font-family:'DM Mono',ui-monospace,monospace; }" +
      ".lk-music-viewport h1, .lk-music-viewport h2, .lk-music-viewport h3 { margin:0; font-family:'Bricolage Grotesque',system-ui,sans-serif; font-weight:700; }" +
      ".lk-music-viewport .eyebrow { font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); }" +
      ".lk-music-viewport .btn { display:inline-flex; align-items:center; gap:8px; height:40px; padding:0 16px; border-radius:999px; font-weight:600; font-size:14px; background:var(--surf2); border:1px solid var(--line); color:var(--text); white-space:nowrap; text-decoration:none; }" +
      ".lk-music-viewport .btn:hover { border-color:var(--acc); }" +
      ".lk-music-viewport .btn.acc { background:var(--acc); color:var(--onacc); border-color:var(--acc); }" +
      ".lk-music-viewport .btn.acc:hover { filter:brightness(1.08); }" +
      ".lk-music-viewport .btn.sm { height:34px; padding:0 14px; font-size:13px; }" +
      ".lk-music-viewport .icb { display:inline-flex; align-items:center; justify-content:center; width:40px; height:40px; border-radius:999px; color:var(--text); flex:none; }" +
      ".lk-music-viewport .icb:hover { background:var(--surf2); }" +
      ".lk-music-viewport .icb.solid { background:var(--acc); color:var(--onacc); }" +
      ".lk-music-viewport .icb.solid:hover { background:var(--acc); filter:brightness(1.08); }" +
      ".lk-music-viewport .pill { display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 12px; border-radius:999px; border:1px solid var(--line); background:var(--surf); font-size:13px; font-weight:500; color:var(--text); white-space:nowrap; text-decoration:none; }" +
      ".lk-music-viewport .pill:hover { border-color:var(--acc); }" +
      ".lk-music-viewport .pill.on { background:var(--acc); color:var(--onacc); border-color:var(--acc); }" +
      ".lk-music-viewport .vis { display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 12px; border-radius:999px; font-size:12.5px; font-weight:600; color:#10131a; }" +
      ".lk-music-viewport .nav { display:flex; align-items:center; gap:10px; width:100%; height:40px; padding:0 12px; border-radius:10px; text-align:left; color:var(--mute); font-weight:500; }" +
      ".lk-music-viewport .nav:hover { background:var(--surf2); color:var(--text); }" +
      ".lk-music-viewport .nav.on { background:var(--accsoft); color:var(--text); }" +
      ".lk-music-viewport .tile .tileplay { opacity:0; transform:translateY(4px); transition:opacity .15s, transform .15s; }" +
      ".lk-music-viewport .tile:hover .tileplay, .lk-music-viewport .tile .tileplay:focus-visible { opacity:1; transform:none; }" +
      ".lk-music-viewport .trow:hover { background:var(--surf2); }" +
      ".lk-music-viewport .trow .ract { opacity:0; }" +
      ".lk-music-viewport .trow:hover .ract, .lk-music-viewport .trow:focus-within .ract { opacity:1; }" +
      ".lk-music-viewport .optcard { display:flex; align-items:flex-start; gap:12px; text-align:left; padding:12px 14px; border-radius:12px; border:1px solid var(--line); background:var(--surf); flex:1 1 220px; }" +
      ".lk-music-viewport .optcard:hover { border-color:var(--acc); }" +
      ".lk-music-viewport .optcard.on { border-color:var(--acc); background:var(--accsoft); }" +
      ".lk-music-viewport .main { flex:1 1 0; min-width:0; overflow-y:auto; padding:24px 28px 40px; scrollbar-width:thin; scrollbar-color:var(--line) transparent; }" +
      ".lk-music-viewport .side { flex:0 0 236px; width:236px; overflow-y:auto; padding:14px 10px 20px; background:var(--side); border-right:1px solid var(--line); }" +
      ".lk-music-viewport .scrim { position:absolute; inset:0; display:flex; align-items:flex-start; justify-content:center; padding:28px 20px; overflow-y:auto; background:var(--scrim); }" +
      ".lk-music-viewport .dlg { position:relative; width:100%; padding:26px; background:var(--surf); border:1px solid var(--line); border-radius:22px; box-shadow:0 24px 60px rgba(0,0,0,.4); }" +
      ".lk-music-viewport .dlg-x { position:absolute; right:12px; top:12px; }" +
      ".lk-music-viewport .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(168px, 1fr)); gap:26px 20px; }" +
      ".lk-music-viewport .ell { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }" +
      ".lk-music-viewport .dashed { padding:34px 28px; border:1px dashed var(--line); border-radius:18px; background:var(--surf); }" +
      "";

    function coverGradient(title) {
      var hash = 0;
      (title || "").split("").forEach(function (ch) { hash = (hash * 31 + ch.charCodeAt(0)) | 0; });
      var pair = COVER_PALETTE[Math.abs(hash) % COVER_PALETTE.length];
      return "radial-gradient(circle at 68% 34%, " + pair[1] + " 0 22%, transparent 22.5%), " + pair[0];
    }

    function fmtTime(sec) {
      var s = Math.max(0, Math.round(sec || 0));
      return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }

    var MusicClass = lively.morphic.Box.subclass(
      "lively.music.Music",

      "serialization",
      {
        // state/_dom/_audio and the live connection/timers are rebuilt in
        // _setup() on every fresh render context. musicLibraryObjId/
        // musicLibraryHandle/musicTheme/musicLibPublic are real serialized
        // Morph properties: all this morph needs to remember across a reload.
        doNotSerialize: ["state", "_dom", "_audio", "_identityConnection", "_didHandleMap", "_libraryEnsurePending", "_catalogLast", "_addSearchTimer", "_toastTimer", "_searchSeq", "_nowPlayingKey", "_albumSave", "_queues", "_importRun", "_importCache", "_importTimer", "_importRenderTimer", "_embedSeq", "_embedTimer"],
      },

      "initialization",
      {
        initialize: function ($super, optExtent) {
          $super(optExtent || lively.rect(0, 0, 1280, 820));
          this.setFill(null);
          this.setBorderWidth(0);
          this.disableDragging();
          this.disableDropping();
          this.disableGrabbing();
        },

        _setup: function () {
          this._dom = {};
          this.state = {
            theme: this.musicTheme || "midnight",
            isOwner: false,
            loaded: false,
            albums: [],
            playlists: [],
            view: "shelf",
            shelf: "all",
            plId: null,
            libMenuOpen: false,
            albumOpen: null,
            comments: [],
            commentsLoading: false,
            commentDraft: "",
            addOpen: false,
            addQ: "",
            addAlbums: [],
            addSongs: [],
            addSearching: false,
            addError: "",
            addPick: null,
            addingKey: null,
            newPlOpen: false,
            newPlName: "",
            newPlVis: "private",
            visMenuOpen: false,
            shareDraft: "",
            pickTracks: null,
            pickNewName: "",
            queue: [],
            qi: 0,
            playing: false,
            elapsed: 0,
            duration: 30,
            queueOpen: false,
            toast: "",
            exportOpen: false,
            exportFmt: "csv",
            embedOpen: false,
            embedUrl: "",
            embed: null,
            embedStatus: "idle",
            importOpen: false,
            importText: "",
            importFormat: "auto",
            importOrder: "artist-title",
            importFileName: "",
            importParsed: null,
            importRows: null,
            importPhase: "idle",
            importVis: "private",
            importNames: {},
            importRemoved: {},
            importSaving: "",
            importError: "",
          };
          this._importRun = 0;
          this._embedSeq = 0;
          this._importCache = {};
          this._didHandleMap = this._didHandleMap || {};
          this._searchSeq = 0;
          this._fitToWorld();
          this._buildChrome();
          this._renderAll();
          this._bindIdentity();
          this._ensureLibrary();
        },

        prepareForNewRenderContext: function ($super, renderCtx) {
          $super(renderCtx);
          this._setup();
        },

        remove: function ($super) {
          this._unbindIdentity();
          this._stopAudio();
          $super();
        },
      },

      "layout",
      {
        _fitToWorld: function () {
          if (typeof $world === "undefined" || !$world) return;
          var vb = $world.visibleBounds();
          // Sit below the world's menu bar, which overlays the top of the
          // viewport and would otherwise clip the header.
          var menuBar = $world.get && $world.get(/^MenuBar/);
          var top = menuBar ? Math.max(0, menuBar.getExtent().y + menuBar.getPosition().y) : 0;
          this.setPosition(vb.topLeft().addXY(0, top));
          this.setExtent(vb.extent().subXY(0, top));
        },
        onWorldResize: function () {
          lively.lang.fun.debounceNamed(this.id + "-music-world-resize", 150, this._fitToWorld.bind(this))();
        },
      },

      "dom helpers",
      {
        _el: function (tag, className, parent) {
          var e = document.createElement(tag);
          if (className) e.className = className;
          if (parent) parent.appendChild(e);
          return e;
        },
        _text: function (tag, className, text, parent) {
          var e = this._el(tag, className, parent);
          e.textContent = text;
          return e;
        },
        // Material Symbols Rounded glyph (font vendored per world, see
        // core/styles/material-symbols.css).
        _icon: function (name, px, parent) {
          var e = this._el("span", "ms", parent);
          e.textContent = name;
          e.style.fontSize = (px || 20) + "px";
          e.setAttribute("aria-hidden", "true");
          return e;
        },
        _clear: function (el) {
          while (el.firstChild) el.removeChild(el.firstChild);
        },
        // Clickable button: optional leading icon + label.
        _btn: function (cls, label, icon, parent, onClick, iconPx) {
          var b = this._el("button", cls, parent);
          b.type = "button";
          if (icon) this._icon(icon, iconPx || 18, b);
          if (label) b.appendChild(document.createTextNode(label));
          if (onClick) b.addEventListener("click", function (e) { e.stopPropagation(); onClick(e); });
          return b;
        },
        _iconBtn: function (cls, icon, label, parent, onClick, px) {
          var b = this._btn("icb " + (cls || ""), null, icon, parent, onClick, px);
          b.setAttribute("aria-label", label);
          return b;
        },
        _setCover: function (el, item) {
          var url = item && item.coverUrl;
          if (url) {
            el.style.backgroundImage = "url('" + String(url).replace(/'/g, "%27") + "')";
            el.style.backgroundSize = "cover";
            el.style.backgroundPosition = "center";
            el.style.backgroundColor = "var(--surf2)";
          } else {
            el.style.background = coverGradient(item && item.title);
          }
        },
        _stars: function (n, px, parent) {
          var wrap = this._el("span", null, parent);
          wrap.style.cssText = "display:inline-flex; letter-spacing:1px; color:#f5b82e; font-size:" + px + "px; line-height:1";
          var s = "";
          for (var i = 1; i <= 5; i++) s += i <= (n || 0) ? "★" : "☆";
          wrap.textContent = s;
          wrap.setAttribute("aria-label", (n || 0) + " of 5 stars");
          return wrap;
        },
        _formatDate: function (iso) {
          if (!iso) return "";
          try {
            return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
          } catch (e) { return ""; }
        },
        _toast: function (msg) {
          var self = this;
          clearTimeout(this._toastTimer);
          this.state.toast = msg;
          this._renderToast();
          this._toastTimer = setTimeout(function () { self.state.toast = ""; self._renderToast(); }, 2800);
        },
      },

      "identity",
      {
        _currentUser: function () {
          if (typeof lively === "undefined" || !lively.identity || !lively.identity.did) return null;
          return lively.identity.did.currentUser();
        },
        // $world.name isn't kept in sync with the assigned display name;
        // document.title is the real source of truth (see Books.js).
        _worldName: function () {
          var t = document.title;
          var isDefault = !t || t === "world" || t === "Lively" || t === "untitled world";
          return isDefault ? "My Music" : t;
        },
        _bindIdentity: function () {
          if (typeof lively === "undefined" || !lively.bindings || !lively.identity || !lively.identity.did) return;
          var self = this;
          this._identityConnection = lively.bindings.connect(lively.identity.did, "identityChanged", self, "_onIdentityChanged");
          if (lively.identity.did.restoreSession) {
            lively.identity.did.restoreSession(function () { self._onIdentityChanged(); });
          }
        },
        _unbindIdentity: function () {
          if (this._identityConnection && this._identityConnection.disconnect) this._identityConnection.disconnect();
          this._identityConnection = null;
        },
        _onIdentityChanged: function () {
          if (!this.state.loaded) this._ensureLibrary();
          else this._recomputeOwnerAndRender();
        },
        _recomputeOwnerAndRender: function () {
          var user = this._currentUser();
          this.state.isOwner = !!(user && this.musicLibraryHandle && user.handle === this.musicLibraryHandle);
          this._renderAll();
        },
        _libPublic: function () {
          return this.musicLibPublic !== false;
        },
        _canSeeLibrary: function () {
          return this.state.isOwner || this._libPublic();
        },
      },

      "chrome building",
      {
        _buildChrome: function () {
          if (!document.getElementById("music-styles")) {
            var styleTag = document.createElement("style");
            styleTag.id = "music-styles";
            styleTag.textContent = MUSIC_CSS;
            document.head.appendChild(styleTag);
          }
          var self = this;
          var shapeNode = this.renderContext().shapeNode;
          shapeNode.innerHTML = "";
          shapeNode.style.overflow = "hidden";

          var vp = this._el("div", "lk-music-viewport", shapeNode);
          vp.dataset.theme = this.state.theme;
          this._dom.viewport = vp;

          this._buildHeader(vp);
          var body = this._el("div", null, vp);
          body.style.cssText = "position:relative; display:flex; flex:1 1 0; min-height:0";
          this._dom.body = body;
          this._dom.side = this._el("aside", "side", body);
          this._dom.main = this._el("main", "main", body);

          this._buildAlbumModal(body);
          this._buildAddModal(body);
          this._buildPickModal(body);
          this._buildImportModal(body);

          this._dom.toast = this._el("div", null, vp);
          this._dom.toast.setAttribute("role", "status");
          this._dom.toast.style.cssText = "display:none; position:absolute; z-index:60; left:50%; bottom:92px; transform:translateX(-50%); max-width:90%; padding:10px 18px; border-radius:999px; background:var(--text); color:var(--bg); font-weight:600; font-size:13.5px; box-shadow:0 10px 26px rgba(0,0,0,.35)";

          this._buildQueuePopover(vp);
          this._buildEmbedPopover(vp);
          this._buildPlayer(vp);
        },

        _buildHeader: function (vp) {
          var self = this;
          var hdr = this._el("header", null, vp);
          hdr.style.cssText = "position:relative; z-index:10; display:flex; flex-wrap:wrap; align-items:center; gap:12px 20px; padding:12px 20px; background:var(--side); border-bottom:1px solid var(--line)";
          this._dom.header = hdr;

          var left = this._el("div", null, hdr);
          left.style.cssText = "display:flex; align-items:center; gap:12px; min-width:0";
          var logo = this._el("div", null, left);
          logo.style.cssText = "width:40px; height:40px; border-radius:12px; background:var(--acc); color:var(--onacc); display:flex; align-items:center; justify-content:center";
          this._icon("music_note", 22, logo);
          var titles = this._el("div", null, left);
          titles.style.minWidth = "0";
          this._dom.titleEl = this._text("div", "display", "", titles);
          this._dom.titleEl.style.cssText = "font-size:20px; font-weight:700; line-height:1.1";
          this._dom.subEl = this._text("div", null, "", titles);
          this._dom.subEl.style.cssText = "font-size:12px; color:var(--mute); margin-top:2px";

          var spacer = this._el("div", null, hdr);
          spacer.style.flex = "1 1 0";

          var swRow = this._el("div", null, hdr);
          swRow.setAttribute("role", "group");
          swRow.setAttribute("aria-label", "Theme");
          swRow.style.cssText = "display:flex; align-items:center; gap:8px";
          this._dom.swatches = {};
          THEME_KEYS.forEach(function (key) {
            var sw = self._el("button", null, swRow);
            sw.type = "button";
            sw.title = THEMES[key].label;
            sw.setAttribute("aria-label", THEMES[key].label + " theme");
            sw.style.cssText = "width:28px; height:28px; border-radius:999px; background:" + THEMES[key].swatch;
            sw.addEventListener("click", function () { self._setTheme(key); });
            self._dom.swatches[key] = sw;
          });

          this._dom.libBtn = this._btn("pill", "", "public", hdr, function () { self._toggleLibMenu(); }, 15);
          this._dom.libBtnLabel = document.createTextNode("");
          this._dom.libBtn.appendChild(this._dom.libBtnLabel);
          this._dom.addBtn = this._btn("btn acc", "Add music", "add", hdr, function () { self._openAdd(); }, 18);

          this._dom.libMenu = this._el("div", null, hdr);
          this._dom.libMenu.style.cssText = "display:none; position:absolute; top:62px; right:20px; width:340px; padding:14px; flex-direction:column; gap:10px; background:var(--surf); border:1px solid var(--line); border-radius:16px; box-shadow:0 18px 44px rgba(0,0,0,.35)";
        },

        _buildAlbumModal: function (body) {
          var self = this;
          var scrim = this._el("div", "scrim", body);
          scrim.style.display = "none";
          scrim.style.zIndex = "20";
          scrim.addEventListener("mousedown", function (e) { if (e.target === scrim) self._closeAlbum(); });
          this._dom.albumScrim = scrim;

          var dlg = this._el("div", "dlg", scrim);
          dlg.style.maxWidth = "960px";
          dlg.setAttribute("role", "dialog");
          dlg.setAttribute("aria-modal", "true");
          dlg.addEventListener("mousedown", function (e) { e.stopPropagation(); });
          var x = this._iconBtn("dlg-x", "close", "Close", dlg, function () { self._closeAlbum(); });
          x.style.zIndex = "2";

          var cols = this._el("div", null, dlg);
          cols.style.cssText = "display:flex; flex-wrap:wrap; gap:28px";
          var left = this._el("div", null, cols);
          left.style.cssText = "flex:0 0 250px; max-width:100%";
          this._dom.dCover = this._el("div", null, left);
          this._dom.dCover.style.cssText = "width:250px; max-width:100%; aspect-ratio:1/1; border-radius:16px; box-shadow:0 12px 30px rgba(0,0,0,.35)";
          this._dom.dActions = this._el("div", null, left);
          this._dom.dActions.style.cssText = "display:flex; flex-direction:column; gap:10px; margin-top:16px";
          this._dom.dLinks = this._el("div", null, left);

          var right = this._el("div", null, cols);
          right.style.cssText = "flex:1 1 380px; min-width:0";
          this._dom.dInfo = this._el("div", null, right);
          this._dom.dTracks = this._el("div", null, right);
          this._dom.dTracks.style.cssText = "margin-top:22px; border-top:1px solid var(--line)";

          var rev = this._el("div", null, right);
          rev.style.cssText = "margin-top:26px; padding-top:20px; border-top:1px solid var(--line)";
          this._dom.dRevHead = this._el("div", null, rev);
          this._dom.dRevHead.style.cssText = "display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin-bottom:12px";
          this._dom.dRevList = this._el("div", null, rev);
          this._dom.dRevList.style.cssText = "display:flex; flex-direction:column; gap:12px";
          var form = this._el("div", null, rev);
          form.style.cssText = "margin-top:16px; display:flex; flex-direction:column; gap:10px";
          this._dom.dRevForm = form;
          var ta = this._el("textarea", null, form);
          ta.rows = 3;
          ta.placeholder = "Write a review or a note to self…";
          ta.addEventListener("input", function () { self.state.commentDraft = ta.value; });
          this._dom.dRevInput = ta;
          var postRow = this._el("div", null, form);
          this._dom.dRevPost = this._btn("btn acc", "Post", null, postRow, function () { self._postComment(); });
          this._dom.dRevNote = this._el("div", null, rev);
          this._dom.dRevNote.style.cssText = "margin-top:14px; font-size:13px; color:var(--mute)";

          this._dom.dFoot = this._el("div", null, right);
          this._dom.dFoot.style.marginTop = "22px";
        },

        _buildAddModal: function (body) {
          var self = this;
          var scrim = this._el("div", "scrim", body);
          scrim.style.display = "none";
          scrim.style.zIndex = "30";
          scrim.style.paddingTop = "36px";
          scrim.addEventListener("mousedown", function (e) { if (e.target === scrim) self._closeAdd(); });
          this._dom.addScrim = scrim;

          var dlg = this._el("div", "dlg", scrim);
          dlg.style.maxWidth = "760px";
          dlg.setAttribute("role", "dialog");
          dlg.setAttribute("aria-modal", "true");
          dlg.addEventListener("mousedown", function (e) { e.stopPropagation(); });
          this._iconBtn("dlg-x", "close", "Close", dlg, function () { self._closeAdd(); });
          var h = this._text("h2", null, "Add music", dlg);
          h.style.cssText = "margin-bottom:14px; font-size:26px";

          var wrap = this._el("div", null, dlg);
          wrap.style.position = "relative";
          var ic = this._icon("search", 20, wrap);
          ic.style.cssText += "; position:absolute; left:14px; top:50%; margin-top:-10px; color:var(--faint)";
          var input = this._el("input", null, wrap);
          input.type = "text";
          input.placeholder = "Search albums, songs, artists…";
          input.style.cssText = "padding-left:42px; height:46px";
          input.addEventListener("input", function () { self._onAddQuery(input.value); });
          this._dom.addInput = input;
          this._dom.addResults = this._el("div", null, dlg);
        },

        _buildPickModal: function (body) {
          var self = this;
          var scrim = this._el("div", "scrim", body);
          scrim.style.display = "none";
          scrim.style.zIndex = "40";
          scrim.addEventListener("mousedown", function (e) { if (e.target === scrim) self._closePick(); });
          this._dom.pickScrim = scrim;

          var dlg = this._el("div", "dlg", scrim);
          dlg.style.maxWidth = "440px";
          dlg.style.marginTop = "60px";
          dlg.setAttribute("role", "dialog");
          dlg.setAttribute("aria-modal", "true");
          dlg.addEventListener("mousedown", function (e) { e.stopPropagation(); });
          this._iconBtn("dlg-x", "close", "Close", dlg, function () { self._closePick(); });
          this._dom.pickTitle = this._text("h2", null, "", dlg);
          this._dom.pickTitle.style.cssText = "font-size:22px; padding-right:40px";
          this._dom.pickList = this._el("div", null, dlg);
          this._dom.pickList.style.cssText = "display:flex; flex-direction:column; gap:4px; margin-top:14px";
          var row = this._el("div", null, dlg);
          row.style.cssText = "display:flex; gap:8px; margin-top:14px";
          var input = this._el("input", null, row);
          input.type = "text";
          input.placeholder = "New playlist name…";
          input.addEventListener("input", function () { self.state.pickNewName = input.value; });
          input.addEventListener("keydown", function (e) { if (e.key === "Enter") self._pickNewPlaylist(); });
          this._dom.pickInput = input;
          this._btn("btn acc", "Create", null, row, function () { self._pickNewPlaylist(); });
        },

        _buildImportModal: function (body) {
          var self = this;
          var scrim = this._el("div", "scrim", body);
          scrim.style.display = "none";
          scrim.style.zIndex = "35";
          scrim.addEventListener("mousedown", function (e) { if (e.target === scrim) self._closeImport(); });
          this._dom.impScrim = scrim;

          var dlg = this._el("div", "dlg", scrim);
          dlg.style.maxWidth = "820px";
          dlg.setAttribute("role", "dialog");
          dlg.setAttribute("aria-modal", "true");
          dlg.addEventListener("mousedown", function (e) { e.stopPropagation(); });
          this._iconBtn("dlg-x", "close", "Close", dlg, function () { self._closeImport(); });
          var h = this._text("h2", null, "Import a playlist", dlg);
          h.style.cssText = "margin-bottom:4px; font-size:26px";
          var intro = this._text("div", null, "Bring a playlist over from another service. Export it as a CSV or text file with a transfer tool, then drop it here. We match every line against the catalog so you can check it before anything is saved.", dlg);
          intro.style.cssText = "color:var(--mute); max-width:600px";

          this._stepHead(dlg, 1, "Your list");
          var row = this._el("div", null, dlg);
          row.style.cssText = "display:flex; flex-wrap:wrap; align-items:center; gap:8px";
          var pick = this._el("label", "btn", row);
          pick.style.cssText = "position:relative; cursor:pointer";
          this._icon("description", 18, pick);
          pick.appendChild(document.createTextNode("Choose a .csv or .txt file"));
          var file = this._el("input", null, pick);
          file.type = "file";
          file.accept = ".csv,.txt,text/csv,text/plain";
          file.setAttribute("aria-label", "Choose a CSV or text file");
          file.style.cssText = "position:absolute; inset:0; width:100%; height:100%; opacity:0; cursor:pointer; padding:0; border:0";
          file.addEventListener("change", function () { self._onImportFile(file.files && file.files[0]); });
          this._dom.impFile = file;
          this._text("span", null, "or paste below.", row).style.cssText = "font-size:13px; color:var(--mute)";
          var sp = this._el("span", null, row);
          sp.style.flex = "1";
          this._dom.impFormats = this._el("span", null, row);
          this._dom.impFormats.setAttribute("role", "group");
          this._dom.impFormats.setAttribute("aria-label", "Format");
          this._dom.impFormats.style.cssText = "display:inline-flex; gap:6px";

          var ta = this._el("textarea", "mono", dlg);
          ta.rows = 6;
          ta.placeholder = "Artist - Track, one per line\n\nor a CSV with a header row:\nTrack name,Artist name,Album name";
          ta.setAttribute("aria-label", "Playlist file contents");
          ta.style.cssText = "margin-top:10px; font-family:'DM Mono',ui-monospace,monospace; font-size:13px; line-height:1.6; white-space:pre; overflow:auto";
          ta.addEventListener("input", function () { self._onImportText(ta.value); });
          this._dom.impText = ta;

          this._dom.impOrder = this._el("div", null, dlg);
          this._dom.impError = this._el("div", null, dlg);
          this._dom.impSummary = this._el("div", null, dlg);
          this._dom.impReview = this._el("div", null, dlg);
          this._dom.impSave = this._el("div", null, dlg);

          var foot = this._el("div", null, dlg);
          foot.style.cssText = "margin-top:24px; padding-top:18px; border-top:1px solid var(--line)";
          this._text("div", "eyebrow", "Connect an account", foot);
          var cards = this._el("div", null, foot);
          cards.style.cssText = "display:flex; flex-wrap:wrap; gap:10px; margin-top:10px";
          [["S", "Spotify", "Use a file for now."], ["A", "Apple Music", "Use a file for now."], ["Y", "YouTube Music", "Use a file for now."]].forEach(function (pv) {
            var c = self._el("div", "optcard", cards);
            c.style.cssText = "flex:1 1 200px; opacity:.72";
            var mono = self._text("span", null, pv[0], c);
            mono.style.cssText = "width:32px; height:32px; flex:none; border-radius:999px; background:var(--surf2); border:1px solid var(--line); display:inline-flex; align-items:center; justify-content:center; font-weight:700; font-size:13px";
            var col = self._el("span", null, c);
            col.style.display = "block";
            var nm = self._el("span", null, col);
            nm.style.cssText = "display:flex; align-items:center; gap:8px; font-weight:600";
            nm.appendChild(document.createTextNode(pv[1]));
            var soon = self._text("span", "mono", "Coming soon", nm);
            soon.style.cssText = "font-size:10.5px; padding:1px 7px; border-radius:999px; background:var(--accsoft); color:var(--acc)";
            self._text("span", null, pv[2], col).style.cssText = "display:block; font-size:12.5px; color:var(--mute); margin-top:2px";
          });
        },
        _stepHead: function (parent, n, label) {
          var head = this._el("div", "eyebrow", parent);
          head.style.cssText = "display:flex; align-items:center; gap:8px; margin:22px 0 8px";
          var num = this._text("span", "mono", String(n), head);
          num.style.cssText = "width:20px; height:20px; border-radius:999px; background:var(--accsoft); color:var(--acc); display:inline-flex; align-items:center; justify-content:center; font-size:11px";
          head.appendChild(document.createTextNode(label));
          return head;
        },

        _buildEmbedPopover: function (vp) {
          var self = this;
          var pop = this._el("div", null, vp);
          pop.setAttribute("role", "dialog");
          pop.setAttribute("aria-label", "Play the full track");
          pop.style.cssText = "display:none; position:absolute; z-index:55; right:20px; bottom:84px; width:420px; max-width:92%; max-height:calc(100% - 120px); overflow-y:auto; padding:16px; background:var(--surf); border:1px solid var(--line); border-radius:16px; box-shadow:0 18px 44px rgba(0,0,0,.4)";
          pop.addEventListener("mousedown", function (e) { e.stopPropagation(); });
          this._dom.embedPop = pop;
          var head = this._el("div", null, pop);
          head.style.cssText = "display:flex; align-items:center; justify-content:space-between";
          this._text("span", "display", "Play the full track", head).style.cssText = "font-weight:700; font-size:17px";
          var x = this._iconBtn("", "close", "Close", head, function () { self._closeEmbed(); }, 18);
          x.style.cssText = "width:30px; height:30px";
          this._text("div", null, "Previews are 30 seconds. Paste a link to a track, album, playlist or video from a supported music site to play the whole thing here.", pop).style.cssText = "font-size:13px; color:var(--mute); margin:4px 0 10px";
          var row = this._el("div", null, pop);
          row.style.cssText = "display:flex; align-items:center; gap:8px";
          var ic = this._icon("link", 20, row);
          ic.style.color = "var(--faint)";
          var input = this._el("input", null, row);
          input.type = "text";
          input.placeholder = "https://…";
          input.setAttribute("aria-label", "Link to the full track");
          input.addEventListener("input", function () { self._onEmbedInput(input.value); });
          this._dom.embedInput = input;
          this._dom.embedBody = this._el("div", null, pop);
        },

        _buildQueuePopover: function (vp) {
          var pop = this._el("div", null, vp);
          pop.style.cssText = "display:none; position:absolute; z-index:55; right:20px; bottom:84px; width:360px; max-width:90%; max-height:340px; overflow-y:auto; padding:10px; background:var(--surf); border:1px solid var(--line); border-radius:16px; box-shadow:0 18px 44px rgba(0,0,0,.4)";
          this._dom.queuePop = pop;
        },

        _buildPlayer: function (vp) {
          var self = this;
          var ft = this._el("footer", null, vp);
          ft.style.cssText = "position:relative; z-index:26; flex:0 0 auto; display:flex; flex-wrap:wrap; align-items:center; gap:10px 24px; padding:10px 20px; background:var(--side); border-top:1px solid var(--line)";

          var now = this._el("div", null, ft);
          now.style.cssText = "flex:1 1 220px; min-width:0; display:flex; align-items:center; gap:12px";
          this._dom.pbCover = this._el("div", null, now);
          this._dom.pbCover.style.cssText = "width:52px; height:52px; flex:none; border-radius:10px; border:1px solid var(--line); background:var(--surf2)";
          var meta = this._el("div", null, now);
          meta.style.minWidth = "0";
          this._dom.pbTitle = this._el("div", "ell", meta);
          this._dom.pbTitle.style.fontWeight = "600";
          this._dom.pbSub = this._el("div", "ell", meta);
          this._dom.pbSub.style.cssText = "font-size:12.5px; color:var(--mute)";

          var mid = this._el("div", null, ft);
          mid.style.cssText = "flex:2 1 340px; min-width:0; display:flex; flex-direction:column; align-items:center; gap:2px";
          var ctl = this._el("div", null, mid);
          ctl.style.cssText = "display:flex; align-items:center; gap:6px";
          this._dom.pbPrev = this._iconBtn("", "skip_previous", "Previous", ctl, function () { self._prevTrack(); }, 24);
          this._dom.pbToggle = this._iconBtn("solid", "play_arrow", "Play", ctl, function () { self._togglePlay(); }, 26);
          this._dom.pbToggle.style.cssText = "width:44px; height:44px";
          this._dom.pbNext = this._iconBtn("", "skip_next", "Next", ctl, function () { self._nextTrack(); }, 24);

          var bar = this._el("div", null, mid);
          bar.style.cssText = "width:100%; max-width:520px; display:flex; align-items:center; gap:10px";
          this._dom.pbElapsed = this._text("span", "mono", "0:00", bar);
          this._dom.pbElapsed.style.cssText = "font-size:11.5px; color:var(--mute); width:34px; text-align:right";
          var seek = this._el("button", "keep", bar);
          seek.type = "button";
          seek.setAttribute("aria-label", "Seek within the preview");
          seek.style.cssText = "flex:1; height:20px; display:flex; align-items:center";
          var track = this._el("span", null, seek);
          track.style.cssText = "display:block; position:relative; width:100%; height:6px; border-radius:999px; background:var(--line)";
          this._dom.pbFill = this._el("span", null, track);
          this._dom.pbFill.style.cssText = "position:absolute; left:0; top:0; bottom:0; border-radius:999px; background:var(--acc); width:0%";
          seek.addEventListener("click", function (e) {
            var r = seek.getBoundingClientRect();
            self._seekTo(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
          });
          this._dom.pbSeek = seek;
          this._dom.pbTotal = this._text("span", "mono", "0:30", bar);
          this._dom.pbTotal.style.cssText = "font-size:11.5px; color:var(--mute); width:34px";

          var right = this._el("div", null, ft);
          right.style.cssText = "flex:1 1 220px; display:flex; align-items:center; justify-content:flex-end; gap:8px";
          var tag = this._text("span", "mono", "30s preview", right);
          tag.style.cssText = "font-size:11px; color:var(--faint)";
          this._dom.pbEmbedBtn = this._btn("pill", "Full track", "link", right, function () { self._toggleEmbed(); }, 16);
          this._dom.pbEmbedBtn.setAttribute("aria-haspopup", "dialog");
          this._dom.pbQueueBtn = this._btn("pill", "", "queue_music", right, function () { self._toggleQueue(); }, 16);
          this._dom.pbQueueLabel = document.createTextNode("Queue");
          this._dom.pbQueueBtn.appendChild(this._dom.pbQueueLabel);
        },
      },

      "theme",
      {
        _setTheme: function (key) {
          this.state.theme = key;
          this.musicTheme = key;
          this._dom.viewport.dataset.theme = key;
          this._renderHeader();
        },
      },

      "storage: library",
      {
        _ensureLibrary: function () {
          var self = this;
          var user = this._currentUser();
          if (this.musicLibraryObjId && this.musicLibraryHandle) return this._loadLibrary();
          if (!user) return; // wait for _onIdentityChanged to retry
          // In-flight guard: _setup()'s own call and _onIdentityChanged()
          // (fired separately by restoreSession's async resolve) can both
          // see musicLibraryObjId unset and both call createFolder.
          if (this._libraryEnsurePending) return;
          this._libraryEnsurePending = true;

          lively.identity.fileCrypto.createFolder("Library", { visibility: "public" }, function (err, result) {
            self._libraryEnsurePending = false;
            if (err) { console.warn("[Music] could not create library:", err.message); return; }
            self.musicLibraryObjId = result.objId;
            self.musicLibraryHandle = user.handle;
            self._loadLibrary();
            // WorldTemplateLauncher deliberately doesn't save for us: the
            // library folder only exists once this async create resolves.
            if (lively.identity.WorldTemplateLauncher && lively.identity.WorldTemplateLauncher._saveCurrentWorld) {
              lively.identity.WorldTemplateLauncher._saveCurrentWorld();
            }
          });
        },

        _loadLibrary: function () {
          var self = this;
          lively.identity.fileCrypto.fetchFolder(this.musicLibraryHandle, this.musicLibraryObjId, function (err, folder) {
            if (err) { console.warn("[Music] could not load library:", err.message); return; }
            self.state.isOwner = folder.isOwner;
            var albumPtrs = folder.files.filter(function (f) { return f.refType === "album"; });
            var plPtrs = folder.files.filter(function (f) { return f.refType === "playlist"; });
            self._loadAlbums(albumPtrs, function (albums) {
              self.state.albums = albums;
              self._loadPlaylists(plPtrs, function (playlists) {
                self.state.playlists = playlists;
                self.state.loaded = true;
                self._renderAll();
                self._resolveShareHandles();
              });
            });
          });
        },

        _loadAlbums: function (pointers, thenDo) {
          var self = this;
          if (!pointers.length) return thenDo([]);
          var out = new Array(pointers.length);
          var remaining = pointers.length;
          pointers.forEach(function (ptr, i) {
            lively.identity.fileCrypto.fetchAlbum(self.musicLibraryHandle, ptr.refObjId, function (err, result) {
              if (!err && result && result.album && !(result.envelope.state && result.envelope.state.deleted)) {
                out[i] = Object.assign({ objId: result.objId, libraryPointerId: ptr.id }, result.album);
              }
              if (--remaining === 0) thenDo(out.filter(Boolean).reverse()); // newest first
            });
          });
        },

        // A private/shared playlist this viewer has no sealed dek for fails to
        // fetchFolder and is skipped silently — a non-recipient never learns
        // it exists.
        _loadPlaylists: function (pointers, thenDo) {
          var self = this;
          if (!pointers.length) return thenDo([]);
          var out = new Array(pointers.length);
          var remaining = pointers.length;
          pointers.forEach(function (ptr, i) {
            lively.identity.fileCrypto.fetchFolder(self.musicLibraryHandle, ptr.refObjId, function (err, folder) {
              if (!err && folder) out[i] = self._playlistFromFolder(folder, ptr.id);
              if (--remaining === 0) thenDo(out.filter(Boolean));
            });
          });
        },

        _playlistFromFolder: function (folder, pointerId) {
          return {
            objId: folder.objId,
            libraryPointerId: pointerId,
            name: folder.name,
            visibility: folder.envelope.visibility,
            recipients: (folder.envelope.record.recipients || []).map(function (r) { return r.did; }),
            entries: folder.files.filter(function (f) { return f.type === "track"; }),
            wantShared: false,
          };
        },

        _resolveShareHandles: function () {
          var self = this;
          var dids = [];
          this.state.playlists.forEach(function (p) {
            p.recipients.forEach(function (d) { if (dids.indexOf(d) === -1) dids.push(d); });
          });
          if (!dids.length) return;
          fetch("/dids/handles?dids=" + encodeURIComponent(dids.join(",")), { credentials: "include" })
            .then(function (r) { return r.ok ? r.json() : { handles: {} }; })
            .then(function (data) {
              self._didHandleMap = Object.assign(self._didHandleMap || {}, data.handles || {});
              self._renderMain();
            }).catch(function () {});
        },
      },

      "catalog",
      {
        // Paced + retried catalog GET. A throttled request is a CORS-less
        // empty 403, which fetch() reports as a network TypeError, so ANY
        // failure is treated as retryable with growing backoff. Calls are
        // spaced >= 900ms apart. isStale() lets a superseded search stop
        // retrying. thenDo(err, json).
        _catalogGet: function (url, isStale, thenDo, onRetry) {
          var self = this;
          var MAX_TRIES = 6;
          function attempt(n) {
            if (isStale && isStale()) return thenDo(new Error("stale"));
            var wait = Math.max(0, (self._catalogLast || 0) + 900 - Date.now()) + (n ? 1500 * n : 0);
            setTimeout(function () {
              if (isStale && isStale()) return thenDo(new Error("stale"));
              self._catalogLast = Date.now();
              fetch(url)
                .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
                .then(function (json) { thenDo(null, json); })
                .catch(function (e) {
                  if (n + 1 < MAX_TRIES) { if (onRetry) onRetry(n + 1, MAX_TRIES - 1); attempt(n + 1); }
                  else thenDo(e);
                });
            }, wait);
          }
          attempt(0);
        },

        _artwork: function (url, px) {
          return url ? String(url).replace(/\/\d+x\d+bb\./, "/" + px + "x" + px + "bb.").replace(/^http:/, "https:") : null;
        },

        _albumFromCatalog: function (r) {
          return {
            key: "a" + r.collectionId,
            catalogId: String(r.collectionId),
            title: r.collectionName || "Untitled",
            artist: r.artistName || "Unknown",
            year: r.releaseDate ? Number(String(r.releaseDate).slice(0, 4)) : null,
            coverUrl: this._artwork(r.artworkUrl100, 300),
            trackCount: r.trackCount || 0,
            storeUrl: r.collectionViewUrl || null,
          };
        },

        _songFromCatalog: function (r) {
          return {
            key: "s" + r.trackId,
            type: "track",
            title: r.trackName || "Untitled",
            artist: r.artistName || "Unknown",
            albumTitle: r.collectionName || "",
            coverUrl: this._artwork(r.artworkUrl100, 300),
            previewUrl: r.previewUrl || null,
            durationMs: r.trackTimeMillis || 0,
            ids: { itunes: String(r.trackId) },
          };
        },

        // Full tracklist for an album snapshot. thenDo(err, tracks).
        _fetchTracklist: function (catalogId, thenDo) {
          var self = this;
          this._catalogGet(CATALOG_LOOKUP + "?id=" + encodeURIComponent(catalogId) + "&entity=song", null, function (err, json) {
            if (err) return thenDo(err);
            var rows = (json.results || []).filter(function (x) { return x.wrapperType === "track"; });
            rows.sort(function (a, b) { return ((a.discNumber || 1) - (b.discNumber || 1)) || ((a.trackNumber || 0) - (b.trackNumber || 0)); });
            thenDo(null, rows.map(function (r, i) {
              return { n: i + 1, title: r.trackName, durationMs: r.trackTimeMillis || 0, previewUrl: r.previewUrl || null, ids: { itunes: String(r.trackId) } };
            }));
          });
        },
      },

      "filtering",
      {
        _albumsOnShelf: function () {
          var key = this.state.shelf;
          if (key === "all") return this.state.albums;
          return this.state.albums.filter(function (a) { return a.shelf === key; });
        },
        _album: function (objId) {
          return this.state.albums.filter(function (a) { return a.objId === objId; })[0] || null;
        },
        _playlist: function (objId) {
          return this.state.playlists.filter(function (p) { return p.objId === objId; })[0] || null;
        },
        _inLibrary: function (catalogId) {
          return this.state.albums.some(function (a) { return a.ids && a.ids.itunes === catalogId; });
        },
        _setShelfFilter: function (key) {
          this.state.view = "shelf";
          this.state.shelf = key;
          this.state.visMenuOpen = false;
          this._renderSide();
          this._renderMain();
        },
        _openPlaylistView: function (objId) {
          this.state.view = "playlist";
          this.state.plId = objId;
          this.state.exportOpen = false;
          this.state.visMenuOpen = false;
          this.state.shareDraft = "";
          this._renderSide();
          this._renderMain();
        },
        // The album's tracks as player/playlist items.
        _albumTrackItems: function (album) {
          return (album.tracks || []).map(function (t) {
            return {
              type: "track", title: t.title, artist: album.artist, albumTitle: album.title,
              coverUrl: album.coverUrl, previewUrl: t.previewUrl, durationMs: t.durationMs, ids: t.ids || {},
            };
          });
        },
      },

      "playback",
      {
        _ensureAudio: function () {
          if (this._audio) return this._audio;
          var self = this;
          var a = new Audio();
          a.preload = "auto";
          a.addEventListener("timeupdate", function () {
            self.state.elapsed = a.currentTime || 0;
            if (isFinite(a.duration) && a.duration > 0) self.state.duration = a.duration;
            self._tickPlayer();
          });
          a.addEventListener("play", function () { self.state.playing = true; self._renderPlayer(); });
          a.addEventListener("pause", function () { self.state.playing = false; self._renderPlayer(); });
          a.addEventListener("ended", function () { self._nextTrack(true); });
          a.addEventListener("error", function () { self._onAudioError(); });
          this._audio = a;
          return a;
        },
        _stopAudio: function () {
          if (!this._audio) return;
          try { this._audio.pause(); this._audio.removeAttribute("src"); this._audio.load(); } catch (e) { /* ignore */ }
          this._audio = null;
        },
        _current: function () {
          return this.state.queue[this.state.qi] || null;
        },
        // Starts playback of `items` (only previewable ones are queued) at
        // `startItem` (or the first). Must be reached from a click so the
        // browser's autoplay policy allows it.
        _playItems: function (items, startItem) {
          var playable = items.filter(function (t) { return !!t.previewUrl; });
          if (!playable.length) { this._toast("No previews available here"); return; }
          var idx = startItem ? Math.max(0, playable.indexOf(startItem)) : 0;
          this.state.queue = playable;
          this._playIndex(idx);
        },
        _playIndex: function (i) {
          var item = this.state.queue[i];
          if (!item) return;
          this._closeEmbed(); // one thing at a time: a preview replaces a full track
          this.state.qi = i;
          this.state.elapsed = 0;
          this.state.duration = 30;
          item._retried = false;
          var a = this._ensureAudio();
          a.src = item.previewUrl;
          var self = this;
          var p = a.play();
          if (p && p.catch) p.catch(function (e) { if (e && e.name !== "AbortError") self._onAudioError(); });
          this._renderPlayer();
          this._renderQueue();
        },
        _togglePlay: function () {
          var a = this._audio;
          if (!a || !this._current()) return;
          if (a.paused) { this._closeEmbed(); var p = a.play(); if (p && p.catch) p.catch(function () {}); }
          else a.pause();
        },
        _nextTrack: function (fromEnded) {
          var s = this.state;
          if (s.qi + 1 < s.queue.length) this._playIndex(s.qi + 1);
          else if (fromEnded) { s.playing = false; s.elapsed = 0; this._renderPlayer(); }
          else if (this._audio) { this._audio.currentTime = 0; }
        },
        _prevTrack: function () {
          var s = this.state;
          if (s.elapsed > 3 || s.qi === 0) { if (this._audio) this._audio.currentTime = 0; }
          else this._playIndex(s.qi - 1);
        },
        _seekTo: function (frac) {
          var a = this._audio;
          if (!a || !this._current()) return;
          var d = isFinite(a.duration) && a.duration > 0 ? a.duration : this.state.duration;
          a.currentTime = frac * d;
        },
        // Preview URLs can rot: re-resolve the track by its catalog id once
        // and retry before giving up and skipping.
        _onAudioError: function () {
          var self = this;
          var item = this._current();
          if (!item) return;
          var id = item.ids && item.ids.itunes;
          if (!item._retried && id) {
            item._retried = true;
            this._catalogGet(CATALOG_LOOKUP + "?id=" + encodeURIComponent(id), null, function (err, json) {
              var row = !err && json && (json.results || [])[0];
              if (row && row.previewUrl && self._current() === item) {
                item.previewUrl = row.previewUrl;
                self._audio.src = row.previewUrl;
                var p = self._audio.play();
                if (p && p.catch) p.catch(function () {});
              } else if (self._current() === item) {
                self._toast("Preview unavailable");
                self._nextTrack(true);
              }
            });
          } else {
            this._toast("Preview unavailable");
            this._nextTrack(true);
          }
        },
        _toggleQueue: function () {
          this.state.queueOpen = !this.state.queueOpen;
          if (this.state.queueOpen && this.state.embedOpen) this._closeEmbed();
          this._renderQueue();
        },
        // Album track items are rebuilt on every render, so match by catalog
        // id (falling back to preview URL) rather than object identity.
        _isNowPlaying: function (item) {
          var cur = this._current();
          if (!item || !cur) return false;
          if (item === cur) return true;
          var a = item.ids && item.ids.itunes, b = cur.ids && cur.ids.itunes;
          if (a && b) return a === b;
          return !!item.previewUrl && item.previewUrl === cur.previewUrl;
        },
      },

      "library mutations",
      {
        // Every FileCrypto folder write is read-modify-write, so two in
        // flight at once both read the same prior version and the later one
        // silently drops the earlier one's change (confirmed live: four quick
        // reorder clicks left the server order different from the screen).
        // All writes to one folder run one at a time, in order; fn gets a
        // done() it must call exactly once.
        _serial: function (key, fn) {
          this._queues = this._queues || {};
          var q = this._queues[key] || (this._queues[key] = { running: false, jobs: [] });
          q.jobs.push(fn);
          if (q.running) return;
          q.running = true;
          (function next() {
            var job = q.jobs.shift();
            if (!job) { q.running = false; return; }
            job(next);
          })();
        },
        _persistWorld: function () {
          if (lively.identity.WorldTemplateLauncher && lively.identity.WorldTemplateLauncher._saveCurrentWorld) {
            lively.identity.WorldTemplateLauncher._saveCurrentWorld();
          }
        },
        _toggleLibMenu: function () {
          this.state.libMenuOpen = !this.state.libMenuOpen;
          this._renderLibMenu();
        },
        _setLibPublic: function (isPublic) {
          this.musicLibPublic = isPublic;
          this.state.libMenuOpen = false;
          this._renderAll();
          this._persistWorld();
        },
        // album: result of _albumFromCatalog. Fetches the tracklist, writes
        // the album envelope, then the library pointer.
        _addAlbum: function (cat, shelf) {
          var self = this;
          if (!this.state.isOwner || this.state.addingKey) return;
          this.state.addingKey = cat.key;
          this.state.addPick = null;
          this._renderAddResults();
          this._fetchTracklist(cat.catalogId, function (err, tracks) {
            if (err) {
              self.state.addingKey = null;
              self.state.addError = "Couldn't reach the catalog to load that tracklist. Try again in a moment.";
              self._renderAddResults();
              return;
            }
            var data = {
              title: cat.title, artist: cat.artist, year: cat.year, coverUrl: cat.coverUrl, coverSource: "itunes",
              ids: { itunes: cat.catalogId }, storeUrl: cat.storeUrl, tracks: tracks, shelf: shelf, rating: 0, isPublic: true,
            };
            lively.identity.fileCrypto.createAlbum(data, function (err1, created) {
              if (err1) { self.state.addingKey = null; self._toast("Couldn't save: " + err1.message); self._renderAddResults(); return; }
              self._serial(self.musicLibraryObjId, function (done) {
              lively.identity.fileCrypto.addPointerToFolder(self.musicLibraryHandle, self.musicLibraryObjId, { refType: "album", refObjId: created.objId }, function (err2, ptr) {
                done();
                self.state.addingKey = null;
                if (err2) { self._toast("Couldn't add to library: " + err2.message); self._renderAddResults(); return; }
                self.state.albums.unshift(Object.assign({ objId: created.objId, libraryPointerId: ptr.id }, data));
                self._toast("Added to " + SHELF_LABELS[shelf]);
                self._renderAll();
              });
              });
            });
          });
        },
        _patchAlbum: function (objId, patch) {
          var album = this._album(objId);
          if (!album || !this.state.isOwner) return;
          Object.assign(album, patch);
          this._renderMain();
          this._renderSide();
          this._renderAlbum();
          this._queueAlbumSave(objId, patch);
        },
        // updateAlbum is read-modify-write, so two saves in flight at once
        // both read the same prior version and the later one silently drops
        // the earlier one's fields (confirmed live: a shelf change followed
        // immediately by a rating click lost the shelf). Saves for one album
        // run one at a time; patches arriving meanwhile are merged into a
        // single follow-up save.
        _queueAlbumSave: function (objId, patch) {
          var self = this;
          this._albumSave = this._albumSave || {};
          var q = this._albumSave[objId] || (this._albumSave[objId] = { running: false, pending: null });
          q.pending = Object.assign(q.pending || {}, patch);
          if (q.running) return;
          q.running = true;
          (function next() {
            var p = q.pending;
            q.pending = null;
            lively.identity.fileCrypto.updateAlbum(self.musicLibraryHandle, objId, p, function (err) {
              if (err) { console.warn("[Music] could not save album:", err.message); self._toast("Couldn't save that change"); }
              if (q.pending) next();
              else q.running = false;
            });
          })();
        },
        _removeAlbum: function (objId) {
          var album = this._album(objId);
          if (!album || !this.state.isOwner) return;
          var self = this;
          lively.identity.fileCrypto.deleteAlbum(this.musicLibraryHandle, objId, function (err) {
            if (err) { self._toast("Couldn't remove: " + err.message); return; }
            self._serial(self.musicLibraryObjId, function (done) {
              lively.identity.fileCrypto.removeFileFromFolder(self.musicLibraryHandle, self.musicLibraryObjId, album.libraryPointerId, function () { done(); });
            });
            self.state.albums = self.state.albums.filter(function (a) { return a.objId !== objId; });
            self.state.albumOpen = null;
            self._renderAll();
          });
        },
      },

      "playlist mutations",
      {
        _startNewPlaylist: function () {
          this.state.newPlOpen = true;
          this.state.newPlName = "";
          this.state.newPlVis = "private";
          this._renderSide();
          if (this._dom.newPlInput) this._dom.newPlInput.focus();
        },
        // Creates the playlist folder + library pointer. thenDo(err, playlist).
        _createPlaylist: function (name, visibility, thenDo) {
          var self = this;
          var vis = visibility === "public" ? "public" : "private";
          lively.identity.fileCrypto.createFolder(name, { visibility: vis }, function (err, created) {
            if (err) return thenDo(err);
            self._serial(self.musicLibraryObjId, function (done) {
            lively.identity.fileCrypto.addPointerToFolder(self.musicLibraryHandle, self.musicLibraryObjId, { refType: "playlist", refObjId: created.objId }, function (err2, ptr) {
              done();
              if (err2) return thenDo(err2);
              var pl = { objId: created.objId, libraryPointerId: ptr.id, name: name, visibility: vis, recipients: [], entries: [], wantShared: visibility === "shared" };
              self.state.playlists.push(pl);
              thenDo(null, pl);
            });
            });
          });
        },
        _confirmNewPlaylist: function () {
          var name = (this.state.newPlName || "").trim();
          if (!name || !this.state.isOwner) return;
          var self = this;
          this._createPlaylist(name, this.state.newPlVis, function (err, pl) {
            if (err) { self._toast("Couldn't create playlist: " + err.message); return; }
            self.state.newPlOpen = false;
            self._openPlaylistView(pl.objId);
          });
        },
        // Appends track items to a playlist in ONE folder write.
        _addTracksToPlaylist: function (pl, items, thenDo) {
          var self = this;
          var entries = items.map(function (t) {
            return {
              type: "track", title: t.title, artist: t.artist, albumTitle: t.albumTitle, coverUrl: t.coverUrl || null,
              previewUrl: t.previewUrl || null, durationMs: t.durationMs || 0, ids: t.ids || {},
            };
          });
          this._serial(pl.objId, function (done) {
            lively.identity.fileCrypto.addEntriesToFolder(self.musicLibraryHandle, pl.objId, entries, function (err, result) {
              done();
              if (err) { self._toast("Couldn't add: " + err.message); return thenDo && thenDo(err); }
              entries.forEach(function (e, i) { e.id = result.ids[i]; e.addedAt = new Date().toISOString(); pl.entries.push(e); });
              self._toast("Added " + entries.length + (entries.length === 1 ? " track" : " tracks") + " to " + pl.name);
              self._renderAll();
              if (thenDo) thenDo(null);
            });
          });
        },
        _openPick: function (items) {
          if (!this.state.isOwner) return;
          this.state.pickTracks = items;
          this.state.pickNewName = "";
          this._dom.pickInput.value = "";
          this._renderPick();
        },
        _closePick: function () {
          this.state.pickTracks = null;
          this._renderPick();
        },
        _pickPlaylist: function (pl) {
          var items = this.state.pickTracks;
          this._closePick();
          if (items) this._addTracksToPlaylist(pl, items);
        },
        _pickNewPlaylist: function () {
          var name = (this.state.pickNewName || "").trim();
          var items = this.state.pickTracks;
          if (!name || !items) return;
          var self = this;
          this._createPlaylist(name, "private", function (err, pl) {
            if (err) { self._toast("Couldn't create playlist: " + err.message); return; }
            self._closePick();
            self._addTracksToPlaylist(pl, items);
          });
        },
        _removeEntry: function (pl, entry) {
          var self = this;
          pl.entries = pl.entries.filter(function (e) { return e !== entry; });
          this._renderMain();
          this._renderSide();
          this._serial(pl.objId, function (done) {
            lively.identity.fileCrypto.removeFileFromFolder(self.musicLibraryHandle, pl.objId, entry.id, function (err) {
              done();
              if (err) { self._toast("Couldn't remove track: " + err.message); }
            });
          });
        },
        _moveEntry: function (pl, entry, delta) {
          var i = pl.entries.indexOf(entry);
          var j = i + delta;
          if (i < 0 || j < 0 || j >= pl.entries.length) return;
          var self = this;
          pl.entries.splice(i, 1);
          pl.entries.splice(j, 0, entry);
          this._renderMain();
          this._serial(pl.objId, function (done) {
            // Reads the order at run time, so queued moves coalesce to the
            // latest on-screen order rather than replaying stale ones.
            lively.identity.fileCrypto.reorderFolderFiles(self.musicLibraryHandle, pl.objId, pl.entries.map(function (e) { return e.id; }), function (err) {
              done();
              if (err) self._toast("Couldn't save the new order: " + err.message);
            });
          });
        },
        _deletePlaylist: function (pl) {
          var self = this;
          if (!this.state.isOwner) return;
          // No hard delete exists for folders: unlisting it from the library
          // is the delete (storage reclamation isn't built anywhere yet).
          this._serial(this.musicLibraryObjId, function (done) {
          lively.identity.fileCrypto.removeFileFromFolder(self.musicLibraryHandle, self.musicLibraryObjId, pl.libraryPointerId, function (err) {
            done();
            if (err) { self._toast("Couldn't delete playlist: " + err.message); return; }
            self.state.playlists = self.state.playlists.filter(function (p) { return p !== pl; });
            self.state.view = "shelf";
            self.state.plId = null;
            self._renderAll();
          });
          });
        },
        // Public <-> Private are real folder migrations. Shared is derived
        // from having >= 1 sealed recipient, so choosing it just reveals the
        // add-by-handle panel (FileCrypto collapses 'shared' with zero
        // recipients back to 'private').
        _setPlaylistVisibility: function (pl, vis) {
          if (!this.state.isOwner) return;
          var self = this;
          this.state.visMenuOpen = false;
          if (vis === "shared") {
            pl.wantShared = true;
            if (pl.visibility === "public") {
              lively.identity.fileCrypto.setFolderVisibility(this.musicLibraryHandle, pl.objId, "private", {}, function (err) {
                if (err) { self._toast("Couldn't change visibility: " + err.message); return; }
                pl.visibility = "private";
                pl.recipients = [];
                self._renderMain(); self._renderSide();
              });
            } else { this._renderMain(); }
            return;
          }
          pl.wantShared = false;
          if (pl.visibility === vis) { this._renderMain(); return; }
          lively.identity.fileCrypto.setFolderVisibility(this.musicLibraryHandle, pl.objId, vis, {}, function (err) {
            if (err) { self._toast("Couldn't change visibility: " + err.message); return; }
            pl.visibility = vis;
            pl.recipients = [];
            self._renderMain(); self._renderSide();
          });
        },
        _addShare: function (pl) {
          var h = (this.state.shareDraft || "").trim().replace(/^@/, "");
          if (!h || !this.state.isOwner) return;
          var self = this;
          this._resolveRecipientPubKeys([h], function (err, result) {
            var entry = result && result.resolved[0];
            if (!entry) { self._toast("Couldn't find @" + h); return; }
            lively.identity.fileCrypto.shareFolder(self.musicLibraryHandle, pl.objId, [entry], function (err2) {
              if (err2) { self._toast("Couldn't share: " + err2.message); return; }
              if (pl.recipients.indexOf(entry.did) === -1) pl.recipients.push(entry.did);
              pl.visibility = "shared";
              self._didHandleMap[entry.did] = entry.handle;
              self.state.shareDraft = "";
              self._renderMain(); self._renderSide();
            });
          });
        },
        _removeShare: function (pl, did) {
          var self = this;
          if (!this.state.isOwner) return;
          lively.identity.fileCrypto.revokeFolderRecipient(this.musicLibraryHandle, pl.objId, did, function (err, result) {
            if (err) { self._toast("Couldn't remove: " + err.message); return; }
            pl.recipients = pl.recipients.filter(function (d) { return d !== did; });
            pl.visibility = result && result.remaining ? "shared" : "private";
            self._renderMain(); self._renderSide();
          });
        },
        // Resolves each @handle to { did, handle, x25519PublicKey } for
        // shareFolder. Same copy of PostCardEditor's resolver Books.js uses,
        // including the CID-integrity check on the fetched profile envelope.
        _resolveRecipientPubKeys: function (handles, thenDo) {
          if (!handles || !handles.length) return thenDo(null, { resolved: [], failed: [] });
          var base = lively.identity.did.baseUrl();
          var resolved = [], failed = [], remaining = handles.length;
          function done() { if (--remaining === 0) thenDo(null, { resolved: resolved, failed: failed }); }
          handles.forEach(function (handle) {
            lively.identity.webKey.resolveHandle(handle, function (err, info) {
              if (err || !info || !info.did) { failed.push(handle); return done(); }
              fetch(base + "/@" + encodeURIComponent(handle) + "/profile", { credentials: "include" })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (env) {
                  var pub = env && env.record && env.record.payload && env.record.payload.accountX25519Pub;
                  if (!pub) { failed.push(handle); return done(); }
                  lively.identity.crypto.computeCid(env.record.payload, function (cidErr, expectedCid) {
                    if (cidErr || expectedCid !== env.record.cid) {
                      console.warn("[Music] Profile envelope for @" + handle + " failed CID integrity check -- refusing to seal to its accountX25519Pub");
                      failed.push(handle); return done();
                    }
                    resolved.push({ did: info.did, handle: handle, x25519PublicKey: pub });
                    done();
                  });
                }).catch(function () { failed.push(handle); done(); });
            });
          });
        },
      },

      "add music",
      {
        _openAdd: function () {
          if (!this.state.isOwner) return;
          this.state.addOpen = true;
          this.state.addQ = "";
          this.state.addAlbums = [];
          this.state.addSongs = [];
          this.state.addError = "";
          this.state.addPick = null;
          this._dom.addInput.value = "";
          this._renderAdd();
          this._dom.addInput.focus();
        },
        _closeAdd: function () {
          this.state.addOpen = false;
          this._renderAdd();
        },
        _onAddQuery: function (value) {
          var self = this;
          this.state.addQ = value;
          clearTimeout(this._addSearchTimer);
          var q = value.trim();
          this._searchSeq++;
          if (!q) {
            this.state.addAlbums = []; this.state.addSongs = []; this.state.addSearching = false; this.state.addError = "";
            this._renderAddResults();
            return;
          }
          this._addSearchTimer = setTimeout(function () { self._searchCatalog(q); }, 500);
        },
        _searchCatalog: function (q) {
          var self = this;
          var seq = ++this._searchSeq;
          var isStale = function () { return seq !== self._searchSeq; };
          this.state.addSearching = true;
          this.state.addError = "";
          this._renderAddResults();
          var base = CATALOG_SEARCH + "?term=" + encodeURIComponent(q);
          // Serial, not parallel: parallel bursts are what trips the throttle.
          this._catalogGet(base + "&entity=album&limit=8", isStale, function (err, albums) {
            if (isStale()) return;
            if (err) { self.state.addSearching = false; self.state.addError = "Couldn't reach the catalog. Check your connection and try again."; self._renderAddResults(); return; }
            self.state.addAlbums = (albums.results || []).filter(function (r) { return r.collectionId; }).map(function (r) { return self._albumFromCatalog(r); });
            self._renderAddResults();
            self._catalogGet(base + "&entity=song&limit=10", isStale, function (err2, songs) {
              if (isStale()) return;
              self.state.addSearching = false;
              if (err2) { self.state.addError = "Couldn't load song results. Albums are shown above."; self._renderAddResults(); return; }
              self.state.addSongs = (songs.results || []).filter(function (r) { return r.trackId; }).map(function (r) { return self._songFromCatalog(r); });
              self._renderAddResults();
            });
          });
        },
      },

      "album detail",
      {
        _openAlbum: function (objId) {
          this.state.albumOpen = objId;
          this.state.comments = [];
          this.state.commentDraft = "";
          this._dom.dRevInput.value = "";
          this._renderAlbum();
          this._loadComments(objId);
        },
        _closeAlbum: function () {
          this.state.albumOpen = null;
          this._renderAlbum();
        },
        _itemUrl: function (objId, suffix) {
          return "/@" + encodeURIComponent(this.musicLibraryHandle) + "/" + encodeURIComponent(objId) + suffix;
        },
        _loadComments: function (objId) {
          var self = this;
          this.state.commentsLoading = true;
          this._renderAlbum();
          fetch(this._itemUrl(objId, "/comments?limit=50"), { credentials: "include" })
            .then(function (r) { return r.ok ? r.json() : { comments: [] }; })
            .then(function (data) {
              if (self.state.albumOpen !== objId) return;
              self.state.comments = data.comments || [];
              self.state.commentsLoading = false;
              self._renderAlbum();
            }).catch(function () {
              if (self.state.albumOpen !== objId) return;
              self.state.commentsLoading = false;
              self._renderAlbum();
            });
        },
        _postComment: function () {
          var text = (this.state.commentDraft || "").trim();
          var objId = this.state.albumOpen;
          if (!text || !objId) return;
          var self = this;
          fetch(this._itemUrl(objId, "/comments"), {
            method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: text }),
          }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
            .then(function () {
              self.state.commentDraft = "";
              self._dom.dRevInput.value = "";
              self._loadComments(objId);
            }).catch(function (e) { self._toast("Couldn't post: " + e.message); });
        },
      },

      "full track",
      {
        _toggleEmbed: function () {
          if (this.state.embedOpen) return this._closeEmbed();
          this.state.embedOpen = true;
          this.state.queueOpen = false;
          this._renderQueue();
          this._renderEmbed();
          this._dom.embedInput.focus();
        },
        // Closing removes the iframe, which also stops whatever it was playing.
        _closeEmbed: function () {
          if (!this.state.embedOpen) return;
          this.state.embedOpen = false;
          this._embedSeq++;
          this._renderEmbed();
        },
        _onEmbedInput: function (value) {
          var self = this;
          this.state.embedUrl = value;
          clearTimeout(this._embedTimer);
          this._embedSeq++;
          this.state.embed = null;
          this.state.embedStatus = value.trim() ? "typing" : "idle";
          this._renderEmbed();
          this._embedTimer = setTimeout(function () { self._resolveEmbed(value); }, 450);
        },
        _embedFrameHeight: function (embedUrl) {
          var u = new URL(embedUrl);
          var h = u.hostname.toLowerCase();
          if (h === "open.spotify.com") return /^\/embed\/(track|episode)\//.test(u.pathname) ? 152 : 352;
          if (h === "w.soundcloud.com") return /\/sets\//.test(decodeURIComponent(u.search)) ? 300 : 166;
          if (h === "embed.music.apple.com") return /[?&]i=/.test(u.search) ? 175 : 450;
          return 152;
        },
        _resolveEmbed: function (raw) {
          var self = this;
          var s = this.state;
          var url = String(raw || "").trim();
          var seq = ++this._embedSeq;
          var fail = function (status) { if (seq !== self._embedSeq) return; s.embed = null; s.embedStatus = status; self._renderEmbed(); };
          if (!url) return fail("idle");
          var u = null;
          try { u = new URL(url); } catch (e) { u = null; }
          if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) return fail("bad");
          if (!EMBED_SOURCES[u.hostname.toLowerCase()]) return fail("unsupported");
          s.embedStatus = "resolving";
          this._renderEmbed();
          fetch("/nodejs/LinkPreviewServer/unfurl?url=" + encodeURIComponent(u.toString()))
            .then(function (r) {
              // 422/404: the link was reachable but has nothing playable.
              if (r.status === 422 || r.status === 404) return {};
              if (!r.ok) throw new Error("HTTP " + r.status);
              return r.json();
            })
            .then(function (d) {
              if (seq !== self._embedSeq) return;
              var host = "";
              try { host = new URL(d.embedUrl).hostname.toLowerCase(); } catch (e) { host = ""; }
              if (!d || EMBED_PROVIDERS.indexOf(d.provider) === -1 || !EMBED_HOSTS[host] || !/^https:\/\//.test(d.embedUrl)) return fail("unplayable");
              s.embed = { link: u.toString(), embedUrl: d.embedUrl, host: host, shape: EMBED_HOSTS[host] };
              s.embedStatus = "ready";
              // One thing at a time: a full track pauses the preview queue.
              if (self._audio && !self._audio.paused) self._audio.pause();
              self._renderEmbed();
            })
            .catch(function () { fail("error"); });
        },
        _renderEmbed: function () {
          var s = this.state;
          var pop = this._dom.embedPop;
          pop.style.display = s.embedOpen ? "" : "none";
          this._dom.pbEmbedBtn.setAttribute("aria-expanded", s.embedOpen ? "true" : "false");
          this._clear(this._dom.embedBody);
          if (!s.embedOpen) return;
          var body = this._dom.embedBody;
          var MSG = {
            bad: "That doesn't look like a link yet. Paste the full address starting with https://",
            unsupported: "That link isn't from a supported music site. Try a track, album or playlist link from a streaming site.",
            unplayable: "That link doesn't point at a track, album, playlist or video that can play here.",
            error: "Couldn't check that link right now. Try again in a moment.",
            resolving: "Checking the link…",
            typing: "",
          };
          if (MSG[s.embedStatus]) this._text("div", null, MSG[s.embedStatus], body).style.cssText = "margin-top:10px; font-size:13px; color:var(--mute)";
          if (s.embedStatus !== "ready" || !s.embed) return;

          var card = this._el("div", null, body);
          card.style.cssText = "margin-top:12px; border-radius:14px; background:var(--bg); border:1px solid var(--line); overflow:hidden";
          var iframe = this._el("iframe", null, card);
          iframe.src = s.embed.embedUrl;
          iframe.title = "Full track player";
          iframe.setAttribute("allowfullscreen", "");
          iframe.referrerPolicy = "strict-origin-when-cross-origin";
          iframe.sandbox = "allow-scripts allow-same-origin allow-popups allow-presentation";
          iframe.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
          iframe.style.cssText = "display:block; width:100%; border:0";
          if (s.embed.shape === "video") iframe.style.aspectRatio = "16 / 9";
          else iframe.style.height = this._embedFrameHeight(s.embed.embedUrl) + "px";
          var foot = this._el("div", null, body);
          foot.style.cssText = "display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:8px";
          this._text("span", "mono", "Embedded player · " + s.embed.host, foot).style.cssText = "font-size:11.5px; color:var(--faint)";
          var a = this._el("a", "pill", foot);
          a.href = s.embed.link;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          this._icon("open_in_new", 14, a);
          a.appendChild(document.createTextNode("Open site"));
          this._text("div", null, "The preview queue pauses while a full track plays. The linked site controls playback and sound.", body).style.cssText = "margin-top:8px; font-size:12px; color:var(--faint)";
        },
      },

      "import",
      {
        _openImport: function () {
          if (!this.state.isOwner) return;
          this._importRun++;
          Object.assign(this.state, {
            importOpen: true, importText: "", importFormat: "auto", importOrder: "artist-title", importFileName: "",
            importParsed: null, importRows: null, importPhase: "idle", importVis: "private",
            importNames: {}, importRemoved: {}, importSaving: "", importError: "",
          });
          this._importCache = {};
          this._dom.impText.value = "";
          this._dom.impFile.value = "";
          this._renderImport();
        },
        _closeImport: function () {
          if (this.state.importSaving) return;
          this._importRun++; // abandons any in-flight matching
          this.state.importOpen = false;
          this._renderImport();
        },
        _onImportText: function (value) {
          var self = this;
          this.state.importText = value;
          clearTimeout(this._importTimer);
          this._importTimer = setTimeout(function () { self._importReparse(); }, 250);
        },
        _importReparse: function () {
          var s = this.state;
          this._importRun++;
          s.importParsed = lively.music.PlaylistIO.parse(s.importText, { format: s.importFormat, order: s.importOrder });
          s.importRows = null;
          s.importPhase = "idle";
          s.importNames = {};
          s.importRemoved = {};
          s.importError = "";
          this._renderImport();
        },
        _onImportFile: function (file) {
          var self = this;
          if (!file) return;
          if (file.size > 1024 * 1024) { this.state.importError = "That file is over 1 MB. Split it into smaller playlists."; this._renderImport(); return; }
          var reader = new FileReader();
          reader.onload = function () {
            self.state.importFileName = file.name.replace(/\.[^.]+$/, "");
            self._dom.impText.value = String(reader.result || "");
            self.state.importText = self._dom.impText.value;
            self._importReparse();
          };
          reader.onerror = function () { self.state.importError = "Couldn't read that file."; self._renderImport(); };
          reader.readAsText(file);
        },

        // ---- matching ------------------------------------------------------
        // Exact path: a file carrying catalog ids is resolved with batched
        // lookups (no search, no throttling). Everything else is searched one
        // row at a time, paced and retried on ANY failure; a row whose
        // retries run out is "unreachable" (re-triable), never "not found".
        _importFindMatches: function () {
          var self = this;
          var s = this.state;
          var parsed = s.importParsed;
          if (!parsed || !parsed.items.length || s.importPhase === "matching") return;
          var run = ++this._importRun;
          var stale = function () { return run !== self._importRun; };
          s.importRows = parsed.items.map(function (it) { return { item: it, status: "pending", hit: null, note: "Waiting…", accepted: false, dropped: false }; });
          s.importPhase = "matching";
          this._renderImport();

          var finish = function () {
            if (stale()) return;
            s.importPhase = "done";
            self._renderImport();
          };
          var byId = function (next) {
            if (parsed.idKind !== "apple") return next();
            var ids = [];
            s.importRows.forEach(function (r) { if (r.item.appleId && ids.indexOf(r.item.appleId) === -1) ids.push(r.item.appleId); });
            var found = {};
            var chunks = [];
            for (var i = 0; i < ids.length; i += 25) chunks.push(ids.slice(i, i + 25));
            (function step(k) {
              if (stale()) return;
              if (k >= chunks.length) {
                s.importRows.forEach(function (r) {
                  var hit = r.item.appleId && found[r.item.appleId];
                  if (hit) { r.status = "ok"; r.hit = hit; r.note = "Matched by id"; }
                });
                return next();
              }
              self._catalogGet(CATALOG_LOOKUP + "?id=" + chunks[k].join(","), stale, function (err, json) {
                if (stale()) return;
                if (!err) (json.results || []).forEach(function (x) { if (x.wrapperType === "track" && x.trackId) found[String(x.trackId)] = x; });
                step(k + 1);
              });
            })(0);
          };
          byId(function () { self._importSearchPending(stale, finish); });
        },

        _importSearchPending: function (stale, done) {
          var self = this;
          var IO = lively.music.PlaylistIO;
          var todo = this.state.importRows.filter(function (r) { return r.status === "pending" || r.status === "unreachable"; });
          (function step(i) {
            if (stale()) return;
            if (i >= todo.length) return done();
            var row = todo[i];
            var q = IO.queryFor(row.item);
            if (!q) { row.status = "miss"; row.note = "No title on this line"; self._renderImportSoon(); return step(i + 1); }
            row.status = "pending"; row.note = "Searching…";
            var url = CATALOG_SEARCH + "?term=" + encodeURIComponent(q) + "&entity=song&limit=10";
            var apply = function (json) {
              var res = IO.rank(row.item, (json.results || []).filter(function (x) { return x.trackId; }));
              row.status = res.status; row.hit = res.hit; row.note = res.note;
            };
            if (self._importCache[url]) { apply(self._importCache[url]); self._renderImportSoon(); return step(i + 1); }
            self._catalogGet(url, stale, function (err, json) {
              if (stale()) return;
              if (err) { row.status = "unreachable"; row.note = "Couldn't reach the catalog. Try again."; }
              else { self._importCache[url] = json; apply(json); }
              self._renderImportSoon();
              step(i + 1);
            }, function (n, max) {
              // The catalog throttles bursts; say so instead of looking stuck.
              row.note = "Catalog is busy, retrying (" + n + " of " + max + ")…";
              self._renderImportSoon();
            });
          })(0);
        },
        _importRetryUnreachable: function () {
          var self = this;
          var s = this.state;
          if (s.importPhase === "matching") return;
          var run = ++this._importRun;
          var stale = function () { return run !== self._importRun; };
          s.importPhase = "matching";
          this._renderImport();
          this._importSearchPending(stale, function () { if (stale()) return; s.importPhase = "done"; self._renderImport(); });
        },
        _importCancel: function () {
          this._importRun++;
          this.state.importPhase = "done";
          this.state.importRows.forEach(function (r) { if (r.status === "pending") { r.status = "unreachable"; r.note = "Stopped before this row was checked."; } });
          this._renderImport();
        },

        _importEff: function (row) {
          return row.status === "check" && row.accepted ? "ok" : row.status;
        },
        _importCounts: function () {
          var self = this;
          var c = { ok: 0, check: 0, miss: 0, unreachable: 0, pending: 0, total: 0 };
          (this.state.importRows || []).forEach(function (r) {
            if (r.dropped) return;
            c[self._importEff(r)]++;
            c.total++;
          });
          return c;
        },
        // [{ key, name, rows, total }] for the groups still wanted; rows are
        // the matched ones that will be saved.
        _importPlan: function () {
          var self = this;
          var s = this.state;
          var parsed = s.importParsed;
          if (!parsed || !s.importRows) return [];
          var fileBase = s.importFileName || "";
          return parsed.groups.filter(function (g) { return !s.importRemoved[g.key]; }).map(function (g) {
            var rows = s.importRows.filter(function (r) { return r.item.group === g.key && !r.dropped && self._importEff(r) === "ok"; });
            var name = s.importNames[g.key] != null ? s.importNames[g.key] : (g.name || fileBase || "Imported playlist");
            return { key: g.key, name: name, rows: rows, total: s.importRows.filter(function (r) { return r.item.group === g.key && !r.dropped; }).length };
          });
        },
        _importSave: function () {
          var self = this;
          var s = this.state;
          var full = this._importPlan();
          var plan = full.filter(function (g) { return g.rows.length && g.name.trim(); });
          if (!plan.length || s.importSaving || !s.isOwner) return;
          var made = [], savedTracks = 0;
          var totalLines = full.reduce(function (n, g) { return n + g.total; }, 0);
          (function step(i) {
            if (i >= plan.length) {
              s.importSaving = "";
              s.importOpen = false;
              self._renderImport();
              self._toast("Imported " + savedTracks + " of " + totalLines + " lines into " + (made.length === 1 ? "“" + made[0].name + "”" : made.length + " playlists"));
              if (made.length) self._openPlaylistView(made[0].objId);
              return;
            }
            var g = plan[i];
            s.importSaving = "Saving " + (i + 1) + " of " + plan.length + ": " + g.name + "…";
            self._renderImportSave();
            self._createPlaylist(g.name.trim(), s.importVis, function (err, pl) {
              if (err) { s.importSaving = ""; s.importError = "Couldn't create “" + g.name + "”: " + err.message; self._renderImport(); return; }
              made.push(pl);
              var items = g.rows.map(function (r) { return self._songFromCatalog(r.hit); });
              self._addTracksToPlaylist(pl, items, function (err2) {
                if (err2) { s.importSaving = ""; s.importError = "Couldn't add tracks to “" + g.name + "”."; self._renderImport(); return; }
                savedTracks += items.length;
                step(i + 1);
              });
            });
          })(0);
        },
      },

      "export",
      {
        // Contents + file name for the current format.
        _exportData: function (pl) {
          var IO = lively.music.PlaylistIO;
          var isCsv = this.state.exportFmt === "csv";
          var body = isCsv ? IO.toCsv(pl.name, pl.entries) : IO.toText(pl.entries);
          return { isCsv: isCsv, body: body, filename: IO.slug(pl.name) + (isCsv ? ".csv" : ".txt") };
        },
        _copyExport: function (pl) {
          var self = this;
          var body = this._exportData(pl).body;
          try {
            navigator.clipboard.writeText(body).then(function () { self._toast("Copied to clipboard"); }, function () { self._toast("Copy is blocked here. Use Download instead."); });
          } catch (e) { this._toast("Copy is blocked here. Use Download instead."); }
        },
      },

      "rendering",
      {
        _renderAll: function () {
          this._renderHeader();
          this._renderSide();
          this._renderMain();
          this._renderAlbum();
          this._renderAdd();
          this._renderPick();
          this._renderImport();
          this._renderPlayer();
          this._renderQueue();
          this._renderToast();
        },

        _renderHeader: function () {
          var self = this;
          var s = this.state;
          this._dom.titleEl.textContent = this._worldName();
          var handle = this.musicLibraryHandle;
          var parts = [];
          if (handle) parts.push("@" + handle);
          if (s.loaded) {
            var showAlbums = this._canSeeLibrary();
            if (showAlbums) parts.push(s.albums.length + (s.albums.length === 1 ? " album" : " albums"));
            parts.push(s.playlists.length + (s.playlists.length === 1 ? " playlist" : " playlists"));
          }
          this._dom.subEl.textContent = parts.join(" · ");
          THEME_KEYS.forEach(function (key) {
            var sw = self._dom.swatches[key];
            sw.style.boxShadow = key === s.theme ? "0 0 0 2px var(--side), 0 0 0 4px var(--text)" : "0 0 0 1px var(--line)";
            sw.setAttribute("aria-pressed", key === s.theme ? "true" : "false");
          });
          var pub = this._libPublic();
          this._dom.libBtn.firstChild.textContent = pub ? "public" : "lock";
          this._dom.libBtnLabel.textContent = "Library: " + (pub ? "Public" : "Private");
          this._dom.libBtn.style.display = s.isOwner ? "" : "none";
          this._dom.addBtn.style.display = s.isOwner ? "" : "none";
          this._renderLibMenu();
        },

        _renderLibMenu: function () {
          var self = this;
          var menu = this._dom.libMenu;
          menu.style.display = this.state.libMenuOpen && this.state.isOwner ? "flex" : "none";
          this._clear(menu);
          if (menu.style.display === "none") return;
          var lab = this._text("div", "eyebrow", "Who can see your library", menu);
          [
            { pub: true, label: "Public", icon: "public", desc: "Anyone who visits can see your shelves, ratings and reviews." },
            { pub: false, label: "Private", icon: "lock", desc: "Visitors only see your playlists. Shelves, ratings and reviews are hidden." },
          ].forEach(function (o) {
            var card = self._el("button", "optcard" + (self._libPublic() === o.pub ? " on" : ""), menu);
            card.type = "button";
            self._icon(o.icon, 22, card).style.marginTop = "2px";
            var col = self._el("span", null, card);
            col.style.display = "block";
            var l = self._text("span", null, o.label, col);
            l.style.cssText = "display:block; font-weight:600";
            var d = self._text("span", null, o.desc, col);
            d.style.cssText = "display:block; font-size:12.5px; color:var(--mute); margin-top:2px";
            card.addEventListener("click", function () { self._setLibPublic(o.pub); });
          });
        },

        _renderSide: function () {
          var self = this;
          var s = this.state;
          var side = this._dom.side;
          this._clear(side);
          // The header's album/playlist counts depend on what the sidebar lists.
          this._renderHeader();

          if (this._canSeeLibrary()) {
            var l1 = this._text("div", "eyebrow", "Shelves", side);
            l1.style.padding = "4px 12px 8px";
            ["all"].concat(SHELF_KEYS).forEach(function (key) {
              var count = key === "all" ? s.albums.length : s.albums.filter(function (a) { return a.shelf === key; }).length;
              var on = s.view === "shelf" && s.shelf === key;
              var b = self._el("button", "nav" + (on ? " on" : ""), side);
              b.type = "button";
              self._icon(SHELF_ICONS[key], 20, b);
              var nm = self._text("span", null, SHELF_LABELS[key], b);
              nm.style.cssText = "flex:1; text-align:left";
              self._text("span", "mono", String(count), b).style.fontSize = "12px";
              b.addEventListener("click", function () { self._setShelfFilter(key); });
            });
          }

          var hdr = this._el("div", null, side);
          hdr.style.cssText = "display:flex; align-items:center; justify-content:space-between; padding:20px 12px 8px";
          this._text("span", "eyebrow", "Playlists", hdr);
          if (s.isOwner) {
            var btns = this._el("span", null, hdr);
            btns.style.cssText = "display:inline-flex; gap:2px";
            var up = this._iconBtn("", "upload", "Import a playlist", btns, function () { self._openImport(); }, 18);
            up.style.cssText = "width:26px; height:26px";
            var plus = this._iconBtn("", "add", "New playlist", btns, function () { self._startNewPlaylist(); }, 18);
            plus.style.cssText = "width:26px; height:26px";
          }

          if (s.newPlOpen && s.isOwner) {
            var form = this._el("div", null, side);
            form.style.cssText = "margin:0 2px 10px; padding:12px; display:flex; flex-direction:column; gap:10px; background:var(--surf); border:1px solid var(--line); border-radius:14px";
            var lab = this._text("label", null, "Playlist name", form);
            lab.style.cssText = "font-size:12px; color:var(--mute)";
            var input = this._el("input", null, form);
            input.type = "text";
            input.placeholder = "e.g. Rainy day";
            input.value = s.newPlName;
            input.addEventListener("input", function () { s.newPlName = input.value; });
            input.addEventListener("keydown", function (e) {
              if (e.key === "Enter") self._confirmNewPlaylist();
              if (e.key === "Escape") { s.newPlOpen = false; self._renderSide(); }
            });
            this._dom.newPlInput = input;
            var vrow = this._el("div", null, form);
            vrow.style.cssText = "display:flex; flex-wrap:wrap; gap:6px";
            ["private", "public"].forEach(function (v) {
              var p = self._btn("pill" + (s.newPlVis === v ? " on" : ""), VIS_LABEL[v], VIS_ICON[v], vrow, function () { s.newPlVis = v; self._renderSide(); }, 14);
              p.setAttribute("aria-pressed", s.newPlVis === v ? "true" : "false");
            });
            var hint = this._text("div", null, "Share with specific people after it's created.", form);
            hint.style.cssText = "font-size:11.5px; color:var(--faint)";
            var brow = this._el("div", null, form);
            brow.style.cssText = "display:flex; gap:8px";
            this._btn("btn acc sm", "Create", null, brow, function () { self._confirmNewPlaylist(); });
            this._btn("btn sm", "Cancel", null, brow, function () { s.newPlOpen = false; self._renderSide(); });
          }

          s.playlists.forEach(function (pl) {
            var on = s.view === "playlist" && s.plId === pl.objId;
            var b = self._el("button", "nav" + (on ? " on" : ""), side);
            b.type = "button";
            b.title = pl.name + " · " + VIS_LABEL[pl.visibility];
            self._icon(VIS_ICON[pl.visibility], 20, b).style.color = VIS_COLOR[pl.visibility];
            var nm = self._text("span", "ell", pl.name, b);
            nm.style.cssText = "flex:1; min-width:0; text-align:left";
            self._text("span", "mono", String(pl.entries.length), b).style.fontSize = "12px";
            b.addEventListener("click", function () { self._openPlaylistView(pl.objId); });
          });
          if (s.loaded && !s.playlists.length) {
            var none = this._text("div", null, s.isOwner ? "No playlists yet." : "No playlists you can open yet.", side);
            none.style.cssText = "padding:6px 12px; font-size:13px; color:var(--faint)";
          }
        },

        _renderMain: function () {
          var s = this.state;
          var main = this._dom.main;
          this._clear(main);
          if (!s.loaded) {
            var p = this._text("div", null, "Loading your library…", main);
            p.style.cssText = "padding:70px 20px; text-align:center; color:var(--faint)";
            return;
          }
          if (s.view === "playlist" && this._playlist(s.plId)) return this._renderPlaylist(main, this._playlist(s.plId));
          if (!this._canSeeLibrary()) return this._renderPrivateBlock(main);
          this._renderShelf(main);
        },

        _renderPrivateBlock: function (main) {
          var box = this._el("div", null, main);
          box.style.cssText = "max-width:520px; margin:60px auto; text-align:center; padding:36px 28px; border:1px dashed var(--line); border-radius:20px; background:var(--surf)";
          var ring = this._el("div", null, box);
          ring.style.cssText = "width:56px; height:56px; border-radius:999px; margin:0 auto 14px; display:flex; align-items:center; justify-content:center; background:var(--accsoft); color:var(--acc)";
          this._icon("lock", 28, ring);
          var h = this._text("div", "display", "This library is private", box);
          h.style.cssText = "font-size:24px; font-weight:700";
          var d = this._text("div", null, "The owner keeps shelves, ratings and reviews to themself. Any playlists they have made public, or shared with you, are listed on the left.", box);
          d.style.cssText = "color:var(--mute); margin-top:8px";
        },

        _renderShelf: function (main) {
          var self = this;
          var s = this.state;
          var albums = this._albumsOnShelf();
          var head = this._el("div", null, main);
          head.style.cssText = "display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 14px; margin-bottom:20px";
          var h1 = this._text("h1", null, SHELF_LABELS[s.shelf], head);
          h1.style.cssText = "font-size:36px; letter-spacing:-.01em";
          this._text("span", "mono", String(albums.length), head).style.cssText = "color:var(--faint); font-size:13px";

          if (!albums.length) {
            var box = this._el("div", "dashed", main);
            box.style.maxWidth = "460px";
            var t = this._text("div", "display", "Nothing on this shelf yet", box);
            t.style.cssText = "font-size:20px; font-weight:700";
            var d = this._text("div", null, s.isOwner ? "Search the catalog and file albums here as you hear them." : "Nothing here yet.", box);
            d.style.cssText = "color:var(--mute); margin-top:6px";
            if (s.isOwner) {
              var b = this._btn("btn acc", "Add music", "add", box, function () { self._openAdd(); });
              b.style.marginTop = "16px";
            }
            return;
          }

          var grid = this._el("div", "grid", main);
          albums.forEach(function (album) {
            var tile = self._el("div", "tile", grid);
            tile.style.minWidth = "0";
            var sq = self._el("div", null, tile);
            sq.style.cssText = "position:relative; width:100%; aspect-ratio:1/1";
            var cov = self._el("button", null, sq);
            cov.type = "button";
            cov.setAttribute("aria-label", "Open " + album.title);
            cov.style.cssText = "position:absolute; inset:0; border-radius:14px; box-shadow:0 6px 18px rgba(0,0,0,.28)";
            self._setCover(cov, album);
            cov.addEventListener("click", function () { self._openAlbum(album.objId); });
            var items = self._albumTrackItems(album);
            var playable = items.some(function (t) { return !!t.previewUrl; });
            var np = items.some(function (t) { return self._isNowPlaying(t); });
            if (np) {
              var badge = self._text("span", "vis", "Now playing", sq);
              badge.style.cssText = "position:absolute; left:10px; top:10px; background:var(--acc); color:var(--onacc); height:24px; font-size:11.5px";
            }
            if (playable) {
              var pb = self._iconBtn("tileplay solid", "play_arrow", "Play " + album.title, sq, function () { self._playItems(items); }, 24);
              pb.style.cssText = "position:absolute; right:10px; bottom:10px; width:44px; height:44px; box-shadow:0 6px 14px rgba(0,0,0,.35)";
            }
            var info = self._el("button", null, tile);
            info.type = "button";
            info.style.cssText = "display:block; width:100%; text-align:left; margin-top:10px; min-width:0";
            info.addEventListener("click", function () { self._openAlbum(album.objId); });
            var tt = self._text("span", "display ell", album.title, info);
            tt.style.cssText = "display:block; font-size:15.5px; font-weight:600";
            var ar = self._text("span", "ell", album.artist + (album.year ? " · " + album.year : ""), info);
            ar.style.cssText = "display:block; font-size:12.5px; color:var(--mute)";
            var meta = self._el("div", null, tile);
            meta.style.cssText = "display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:6px; min-height:16px";
            if (album.rating) self._stars(album.rating, 13, meta);
            else self._text("span", null, "Not rated", meta).style.cssText = "font-size:12px; color:var(--faint)";
            self._text("span", "mono", SHELF_LABELS[album.shelf] || album.shelf, meta).style.cssText = "font-size:11px; color:var(--faint); white-space:nowrap";
          });
        },

        _entryTotalSeconds: function (entries) {
          return entries.reduce(function (n, e) { return n + (e.durationMs || 0) / 1000; }, 0);
        },

        _renderPlaylist: function (main, pl) {
          var self = this;
          var s = this.state;
          var owner = s.isOwner;
          var items = pl.entries;
          var hdr = this._el("div", null, main);
          hdr.style.cssText = "display:flex; flex-wrap:wrap; align-items:flex-end; gap:22px 26px";

          var mosaic = this._el("div", null, hdr);
          mosaic.style.cssText = "width:172px; height:172px; flex:none; border-radius:16px; overflow:hidden; display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); grid-template-rows:repeat(2, minmax(0,1fr)); box-shadow:0 10px 28px rgba(0,0,0,.32); background:var(--surf2)";
          for (var i = 0; i < 4; i++) {
            var cell = this._el("div", null, mosaic);
            var src = items[i % Math.max(1, items.length)];
            if (src) this._setCover(cell, { coverUrl: src.coverUrl, title: src.albumTitle || src.title });
          }

          var col = this._el("div", null, hdr);
          col.style.cssText = "flex:1 1 300px; min-width:0";
          this._text("div", "eyebrow", "Playlist", col);
          var h1 = this._text("h1", null, pl.name, col);
          h1.style.cssText = "margin:4px 0 12px; font-size:44px; letter-spacing:-.015em; line-height:1.05";
          var meta = this._el("div", null, col);
          meta.style.cssText = "display:flex; flex-wrap:wrap; align-items:center; gap:10px 14px";
          var vis = pl.visibility;
          var chip = this._el(owner ? "button" : "span", "vis", meta);
          chip.style.background = VIS_COLOR[vis];
          if (owner) chip.type = "button";
          this._icon(VIS_ICON[vis], 16, chip);
          chip.appendChild(document.createTextNode(VIS_LABEL[vis]));
          if (owner) {
            this._icon("expand_more", 16, chip);
            chip.setAttribute("aria-expanded", s.visMenuOpen ? "true" : "false");
            chip.addEventListener("click", function () { s.visMenuOpen = !s.visMenuOpen; self._renderMain(); });
          }
          var total = this._entryTotalSeconds(items);
          this._text("span", null, items.length + (items.length === 1 ? " track" : " tracks") + (items.length ? " · " + fmtTime(total) : ""), meta).style.cssText = "color:var(--mute); font-size:13.5px";

          var acts = this._el("div", null, col);
          acts.style.cssText = "display:flex; flex-wrap:wrap; gap:10px; margin-top:18px";
          var playable = items.some(function (e) { return !!e.previewUrl; });
          var playAll = this._btn("btn acc", "Play all", "play_arrow", acts, function () { self._playItems(items.slice()); }, 20);
          playAll.disabled = !playable;
          var shuf = this._btn("btn", "Shuffle", "shuffle", acts, function () {
            var copy = items.slice();
            for (var k = copy.length - 1; k > 0; k--) { var j = Math.floor(Math.random() * (k + 1)); var t = copy[k]; copy[k] = copy[j]; copy[j] = t; }
            self._playItems(copy);
          }, 18);
          shuf.disabled = !playable;
          var exp = this._btn("btn", "Export", "download", acts, function () { s.exportOpen = !s.exportOpen; self._renderMain(); }, 18);
          exp.setAttribute("aria-expanded", s.exportOpen ? "true" : "false");
          if (owner) this._btn("btn", "Delete", "delete", acts, function () { self._deletePlaylist(pl); }, 18);

          if (owner && s.visMenuOpen) {
            var picker = this._el("div", null, main);
            picker.style.cssText = "display:flex; flex-wrap:wrap; gap:10px; margin-top:20px";
            ["private", "shared", "public"].forEach(function (v) {
              var on = pl.visibility === v || (v === "shared" && pl.wantShared && pl.visibility !== "public");
              var card = self._el("button", "optcard" + (on ? " on" : ""), picker);
              card.type = "button";
              self._icon(VIS_ICON[v], 22, card).style.marginTop = "2px";
              var cc = self._el("span", null, card);
              cc.style.display = "block";
              self._text("span", null, VIS_LABEL[v], cc).style.cssText = "display:block; font-weight:600";
              self._text("span", null, VIS_DESC[v], cc).style.cssText = "display:block; font-size:12.5px; color:var(--mute); margin-top:2px";
              card.addEventListener("click", function () { self._setPlaylistVisibility(pl, v); });
            });
          }

          if (s.exportOpen) this._renderExportPanel(main, pl);
          if (owner && (pl.visibility === "shared" || (pl.wantShared && pl.visibility !== "public"))) this._renderSharePanel(main, pl);

          var list = this._el("div", null, main);
          list.style.marginTop = "26px";
          var cols = "22px 34px minmax(0,3fr) minmax(0,2fr) 52px 112px";
          var head = this._el("div", null, list);
          head.style.cssText = "display:grid; grid-template-columns:" + cols + "; gap:12px; padding:0 10px 8px; font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); border-bottom:1px solid var(--line)";
          ["", "#", "Title", "Album", "Time", ""].forEach(function (t) { self._text("span", null, t, head); });

          items.forEach(function (entry, idx) {
            var row = self._el("div", "trow", list);
            row.style.cssText = "display:grid; grid-template-columns:" + cols + "; gap:12px; align-items:center; padding:7px 10px; border-radius:10px";
            var grip = self._el("span", null, row);
            grip.style.cssText = "color:var(--faint); display:flex; align-items:center";
            var np = self._isNowPlaying(entry);
            var pb = self._el("button", "icb keep", row);
            pb.type = "button";
            pb.style.cssText = "width:32px; height:32px; color:" + (np ? "var(--acc)" : "var(--faint)");
            pb.disabled = !entry.previewUrl;
            pb.setAttribute("aria-label", "Play " + entry.title);
            if (np) self._icon(self.state.playing ? "graphic_eq" : "play_arrow", 18, pb);
            else self._text("span", "mono", String(idx + 1), pb).style.fontSize = "13px";
            pb.addEventListener("click", function () {
              if (np) self._togglePlay(); else self._playItems(items.slice(), entry);
            });
            var tcell = self._el("div", null, row);
            tcell.style.cssText = "display:flex; align-items:center; gap:12px; min-width:0";
            var cov = self._el("div", null, tcell);
            cov.style.cssText = "width:42px; height:42px; flex:none; border-radius:8px";
            self._setCover(cov, { coverUrl: entry.coverUrl, title: entry.albumTitle || entry.title });
            var tx = self._el("div", null, tcell);
            tx.style.minWidth = "0";
            self._text("div", "ell", entry.title, tx).style.cssText = "font-weight:600; color:" + (np ? "var(--acc)" : "var(--text)");
            self._text("div", "ell", entry.artist, tx).style.cssText = "font-size:12.5px; color:var(--mute)";
            self._text("div", "ell", entry.albumTitle || "", row).style.cssText = "color:var(--mute); font-size:13px";
            self._text("span", "mono", entry.durationMs ? fmtTime(entry.durationMs / 1000) : "", row).style.cssText = "font-size:12.5px; color:var(--mute)";
            var act = self._el("div", "ract", row);
            act.style.cssText = "display:flex; justify-content:flex-end; gap:2px";
            if (owner) {
              [["arrow_upward", "Move up", -1], ["arrow_downward", "Move down", 1]].forEach(function (a) {
                var b = self._iconBtn("", a[0], a[1], act, function () { self._moveEntry(pl, entry, a[2]); }, 18);
                b.style.cssText = "width:28px; height:28px";
              });
              var rm = self._iconBtn("", "close", "Remove from playlist", act, function () { self._removeEntry(pl, entry); }, 18);
              rm.style.cssText = "width:28px; height:28px";
            }
          });
          if (!items.length) {
            var e = this._text("div", null, owner ? "No tracks yet. Open an album and use the + next to any track." : "No tracks yet.", list);
            e.style.cssText = "padding:28px 10px; color:var(--mute)";
          }
        },

        _renderSharePanel: function (main, pl) {
          var self = this;
          var box = this._el("div", null, main);
          box.style.cssText = "margin-top:20px; padding:16px 18px; background:var(--surf); border:1px solid var(--line); border-radius:16px";
          var row = this._el("div", null, box);
          row.style.cssText = "display:flex; flex-wrap:wrap; align-items:center; gap:8px";
          this._text("span", "eyebrow", "Shared with", row).style.marginRight = "6px";
          pl.recipients.forEach(function (did) {
            var chip = self._el("span", "pill", row);
            chip.style.paddingRight = "6px";
            chip.appendChild(document.createTextNode("@" + (self._didHandleMap[did] || did.slice(0, 10))));
            var x = self._iconBtn("", "close", "Remove access", chip, function () { self._removeShare(pl, did); }, 14);
            x.style.cssText = "width:22px; height:22px";
          });
          if (!pl.recipients.length) {
            this._text("span", null, "Nobody yet — until you add someone, only you can open it.", row).style.cssText = "font-size:13px; color:var(--mute)";
          }
          var form = this._el("div", null, box);
          form.style.cssText = "display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; max-width:420px";
          var wrap = this._el("div", null, form);
          wrap.style.flex = "1 1 180px";
          var input = this._el("input", null, wrap);
          input.type = "text";
          input.placeholder = "Add by @handle";
          input.value = this.state.shareDraft;
          input.addEventListener("input", function () { self.state.shareDraft = input.value; });
          input.addEventListener("keydown", function (e) { if (e.key === "Enter") self._addShare(pl); });
          var add = this._btn("btn", "Add", null, form, function () { self._addShare(pl); });
          add.style.height = "42px";
        },

        _renderAlbum: function () {
          var self = this;
          var s = this.state;
          var album = s.albumOpen ? this._album(s.albumOpen) : null;
          this._dom.albumScrim.style.display = album ? "" : "none";
          if (!album) return;
          var owner = s.isOwner;
          var items = this._albumTrackItems(album);

          this._setCover(this._dom.dCover, album);

          var acts = this._dom.dActions;
          this._clear(acts);
          var playable = items.some(function (t) { return !!t.previewUrl; });
          var play = this._btn("btn acc", "Play previews", "play_arrow", acts, function () { self._playItems(items); }, 20);
          play.style.justifyContent = "center";
          play.disabled = !playable;
          if (owner) {
            var addAll = this._btn("btn", "Add all tracks to playlist", "add", acts, function () { self._openPick(items); }, 18);
            addAll.style.justifyContent = "center";
          }
          var links = this._dom.dLinks;
          this._clear(links);
          if (album.storeUrl && /^https:\/\//.test(album.storeUrl)) {
            this._text("div", "eyebrow", "Listen elsewhere", links).style.marginTop = "16px";
            var lrow = this._el("div", null, links);
            lrow.style.cssText = "display:flex; flex-wrap:wrap; gap:8px; margin-top:8px";
            var a = this._el("a", "pill", lrow);
            a.href = album.storeUrl;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            this._icon("open_in_new", 16, a);
            a.appendChild(document.createTextNode("Store page"));
          }

          var info = this._dom.dInfo;
          this._clear(info);
          this._text("div", "eyebrow", (SHELF_LABELS[album.shelf] || "") + (album.year ? " · " + album.year : ""), info);
          var h = this._text("h2", null, album.title, info);
          h.style.cssText = "margin:4px 0 2px; font-size:38px; letter-spacing:-.015em; line-height:1.05; padding-right:44px";
          this._text("div", null, album.artist, info).style.cssText = "font-size:17px; color:var(--mute)";
          this._text("div", null, "Catalog snapshot taken when added · " + (album.tracks || []).length + " tracks", info).style.cssText = "margin-top:6px; font-size:12.5px; color:var(--faint)";

          var shelfRow = this._el("div", null, info);
          shelfRow.setAttribute("role", "group");
          shelfRow.setAttribute("aria-label", "Shelf");
          shelfRow.style.cssText = "display:flex; flex-wrap:wrap; gap:8px; margin-top:18px";
          SHELF_KEYS.forEach(function (k) {
            var on = album.shelf === k;
            var p = self._btn("pill keep" + (on ? " on" : ""), SHELF_LABELS[k], SHELF_ICONS[k], shelfRow, function () { self._patchAlbum(album.objId, { shelf: k }); }, 16);
            p.disabled = !owner;
            p.setAttribute("aria-pressed", on ? "true" : "false");
          });

          var rate = this._el("div", null, info);
          rate.style.cssText = "display:flex; align-items:center; gap:10px; margin-top:14px";
          var stars = this._el("span", null, rate);
          stars.setAttribute("role", "group");
          stars.setAttribute("aria-label", "Rating");
          stars.style.display = "inline-flex";
          for (var n = 1; n <= 5; n++) {
            (function (n) {
              var b = self._el("button", "icb keep", stars);
              b.type = "button";
              b.style.cssText = "width:34px; height:34px; font-size:26px; line-height:1; color:" + (n <= (album.rating || 0) ? "#f5b82e" : "var(--faint)");
              b.textContent = n <= (album.rating || 0) ? "★" : "☆";
              b.disabled = !owner;
              b.setAttribute("aria-label", "Rate " + n + (n === 1 ? " star" : " stars"));
              b.addEventListener("click", function () { self._patchAlbum(album.objId, { rating: album.rating === n ? 0 : n }); });
            })(n);
          }
          this._text("span", null, album.rating ? album.rating + " of 5" : (owner ? "Not rated yet" : "Not rated"), rate).style.cssText = "font-size:13px; color:var(--mute)";

          var tr = this._dom.dTracks;
          this._clear(tr);
          items.forEach(function (t, i) {
            var row = self._el("div", "trow", tr);
            row.style.cssText = "display:grid; grid-template-columns:34px minmax(0,1fr) 48px 34px; gap:10px; align-items:center; padding:5px 6px; border-radius:8px";
            var np = self._isNowPlaying(t);
            var pb = self._el("button", "icb keep", row);
            pb.type = "button";
            pb.style.cssText = "width:30px; height:30px; color:" + (np ? "var(--acc)" : "var(--faint)");
            pb.disabled = !t.previewUrl;
            pb.setAttribute("aria-label", "Play " + t.title);
            if (np) self._icon(self.state.playing ? "graphic_eq" : "play_arrow", 18, pb);
            else self._text("span", "mono", String(i + 1), pb).style.fontSize = "12.5px";
            pb.addEventListener("click", function () { if (np) self._togglePlay(); else self._playItems(items, t); });
            self._text("span", "ell", t.title, row).style.cssText = "font-weight:500; color:" + (np ? "var(--acc)" : "var(--text)");
            self._text("span", "mono", t.durationMs ? fmtTime(t.durationMs / 1000) : "", row).style.cssText = "font-size:12.5px; color:var(--mute)";
            var act = self._el("span", "ract", row);
            if (owner) {
              var ab = self._iconBtn("", "add", "Add " + t.title + " to a playlist", act, function () { self._openPick([t]); }, 18);
              ab.style.cssText = "width:28px; height:28px";
            }
          });

          this._renderReviews(album);

          var foot = this._dom.dFoot;
          this._clear(foot);
          if (owner) this._btn("pill", "Remove from library", "delete", foot, function () { self._removeAlbum(album.objId); }, 16);
        },

        _renderReviews: function (album) {
          var self = this;
          var s = this.state;
          var owner = s.isOwner;
          var canSee = owner || album.isPublic !== false;
          var user = this._currentUser();

          var head = this._dom.dRevHead;
          this._clear(head);
          this._text("h3", null, "Reviews & notes", head).style.fontSize = "20px";
          if (owner) {
            var pub = album.isPublic !== false;
            var chip = this._btn("vis", pub ? "Public" : "Private", pub ? "public" : "lock", head, function () { self._patchAlbum(album.objId, { isPublic: !pub }); }, 16);
            chip.style.background = pub ? VIS_COLOR.public : VIS_COLOR.private;
            chip.setAttribute("aria-label", "Toggle review visibility");
          }

          var list = this._dom.dRevList;
          this._clear(list);
          if (!canSee) {
            var lock = this._el("div", null, list);
            lock.style.cssText = "display:flex; align-items:center; gap:10px; padding:14px 16px; border:1px dashed var(--line); border-radius:14px; color:var(--mute)";
            this._icon("lock", 20, lock);
            lock.appendChild(document.createTextNode("The owner keeps reviews and notes on this album private."));
          } else if (s.commentsLoading) {
            this._text("div", null, "Loading…", list).style.color = "var(--mute)";
          } else if (!s.comments.length) {
            this._text("div", null, "No reviews yet.", list).style.color = "var(--mute)";
          } else {
            s.comments.forEach(function (c) {
              var row = self._el("div", null, list);
              row.style.cssText = "display:flex; gap:12px";
              var handle = c.handle || "someone";
              var av = self._text("div", null, handle.charAt(0).toUpperCase(), row);
              av.style.cssText = "width:34px; height:34px; flex:none; border-radius:999px; background:var(--accsoft); color:var(--acc); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px";
              var col = self._el("div", null, row);
              col.style.cssText = "min-width:0; flex:1";
              var top = self._el("div", null, col);
              top.style.cssText = "display:flex; flex-wrap:wrap; align-items:center; gap:4px 10px";
              self._text("span", null, "@" + handle, top).style.fontWeight = "600";
              self._text("span", "mono", self._formatDate(c.createdAt), top).style.cssText = "font-size:11.5px; color:var(--faint)";
              var body = self._text("div", null, c.body, col);
              body.style.cssText = "margin-top:3px; color:var(--text); white-space:pre-wrap; overflow-wrap:anywhere";
            });
          }

          this._dom.dRevForm.style.display = canSee && user ? "flex" : "none";
          this._dom.dRevPost.textContent = user ? "Post as @" + user.handle : "Post";
          var note = this._dom.dRevNote;
          note.textContent = canSee && !user ? "Sign in to leave a review." : "";
        },

        _renderAdd: function () {
          this._dom.addScrim.style.display = this.state.addOpen ? "" : "none";
          this._renderAddResults();
        },

        _renderAddResults: function () {
          var self = this;
          var s = this.state;
          var box = this._dom.addResults;
          this._clear(box);
          if (!s.addOpen) return;
          var q = (s.addQ || "").trim();

          if (!q) {
            var hint = this._el("div", null, box);
            hint.style.cssText = "margin-top:18px; color:var(--mute)";
            hint.appendChild(document.createTextNode("Search the catalog, then file an album on a shelf."));
            return;
          }
          if (s.addError) {
            var err = this._text("div", null, s.addError, box);
            err.style.cssText = "margin-top:18px; color:var(--mute)";
          }
          if (s.addSearching && !s.addAlbums.length) {
            this._text("div", null, "Searching…", box).style.cssText = "margin-top:18px; color:var(--mute)";
          }
          if (!s.addSearching && !s.addError && !s.addAlbums.length && !s.addSongs.length) {
            this._text("div", null, "Nothing found for “" + q + "”.", box).style.cssText = "margin-top:18px; color:var(--mute)";
          }

          if (s.addAlbums.length) {
            this._text("div", "eyebrow", "Albums", box).style.marginTop = "20px";
            var list = this._el("div", null, box);
            list.style.cssText = "display:flex; flex-direction:column; margin-top:6px";
            s.addAlbums.forEach(function (a) {
              var row = self._el("div", null, list);
              row.style.cssText = "display:flex; flex-wrap:wrap; align-items:center; gap:10px 14px; padding:10px 6px; border-bottom:1px solid var(--line)";
              var cov = self._el("div", null, row);
              cov.style.cssText = "width:56px; height:56px; flex:none; border-radius:10px";
              self._setCover(cov, a);
              var col = self._el("div", null, row);
              col.style.cssText = "flex:1 1 200px; min-width:0";
              self._text("div", "display ell", a.title, col).style.cssText = "font-weight:600; font-size:16px";
              self._text("div", null, a.artist + (a.year ? " · " + a.year : "") + (a.trackCount ? " · " + a.trackCount + " tracks" : ""), col).style.cssText = "font-size:13px; color:var(--mute)";
              if (self._inLibrary(a.catalogId)) {
                var inl = self._el("span", null, row);
                inl.style.cssText = "display:inline-flex; align-items:center; gap:6px; color:var(--mute); font-size:13px; font-weight:600";
                self._icon("check", 18, inl);
                inl.appendChild(document.createTextNode("In library"));
              } else if (s.addingKey === a.key) {
                self._text("span", null, "Adding…", row).style.cssText = "color:var(--mute); font-size:13px; font-weight:600";
              } else {
                self._btn("btn sm", "Add", "add", row, function () { s.addPick = s.addPick === a.key ? null : a.key; self._renderAddResults(); }, 18);
              }
              if (s.addPick === a.key) {
                var pick = self._el("div", null, row);
                pick.style.cssText = "flex:1 1 100%; display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding-left:70px";
                self._text("span", null, "File on:", pick).style.cssText = "font-size:13px; color:var(--mute)";
                SHELF_KEYS.forEach(function (k) {
                  self._btn("pill", SHELF_LABELS[k], SHELF_ICONS[k], pick, function () { self._addAlbum(a, k); }, 16);
                });
              }
            });
          }

          if (s.addSongs.length) {
            this._text("div", "eyebrow", "Songs", box).style.marginTop = "20px";
            var slist = this._el("div", null, box);
            slist.style.cssText = "display:flex; flex-direction:column; margin-top:6px";
            s.addSongs.forEach(function (t) {
              var row = self._el("div", "trow", slist);
              row.style.cssText = "display:flex; align-items:center; gap:12px; padding:6px; border-radius:10px";
              var np = self._isNowPlaying(t);
              var pb = self._iconBtn("solid", np && self.state.playing ? "pause" : "play_arrow", "Play " + t.title, row, function () {
                if (np) self._togglePlay(); else self._playItems(s.addSongs, t);
              }, 20);
              pb.style.cssText = "width:34px; height:34px";
              pb.disabled = !t.previewUrl;
              var cov = self._el("div", null, row);
              cov.style.cssText = "width:40px; height:40px; flex:none; border-radius:8px";
              self._setCover(cov, t);
              var col = self._el("div", null, row);
              col.style.cssText = "flex:1; min-width:0";
              self._text("div", "ell", t.title, col).style.fontWeight = "600";
              self._text("div", "ell", t.artist + " · " + t.albumTitle, col).style.cssText = "font-size:12.5px; color:var(--mute)";
              self._text("span", "mono", t.durationMs ? fmtTime(t.durationMs / 1000) : "", row).style.cssText = "font-size:12.5px; color:var(--mute)";
              if (s.isOwner) self._btn("pill", "Playlist", "add", row, function () { self._openPick([t]); }, 16);
            });
          }
        },

        _renderPick: function () {
          var self = this;
          var s = this.state;
          var items = s.pickTracks;
          this._dom.pickScrim.style.display = items ? "" : "none";
          if (!items) return;
          this._dom.pickTitle.textContent = items.length === 1 ? "Add “" + items[0].title + "” to…" : "Add " + items.length + " tracks to…";
          var list = this._dom.pickList;
          this._clear(list);
          s.playlists.forEach(function (pl) {
            var b = self._el("button", "nav", list);
            b.type = "button";
            self._icon(VIS_ICON[pl.visibility], 20, b).style.color = VIS_COLOR[pl.visibility];
            self._text("span", "ell", pl.name, b).style.cssText = "flex:1; min-width:0; text-align:left";
            self._text("span", "mono", String(pl.entries.length), b).style.fontSize = "12px";
            b.addEventListener("click", function () { self._pickPlaylist(pl); });
          });
          if (!s.playlists.length) this._text("div", null, "You have no playlists yet — name a new one below.", list).style.cssText = "color:var(--mute); font-size:13px";
        },

        _renderImport: function () {
          var self = this;
          var s = this.state;
          this._dom.impScrim.style.display = s.importOpen ? "" : "none";
          if (!s.importOpen) return;
          var parsed = s.importParsed;

          var fmts = this._dom.impFormats;
          this._clear(fmts);
          [["auto", "Auto-detect"], ["csv", "CSV"], ["text", "Text"]].forEach(function (f) {
            var on = s.importFormat === f[0];
            var b = self._btn("pill" + (on ? " on" : ""), f[1], null, fmts, function () { s.importFormat = f[0]; self._importReparse(); });
            b.setAttribute("aria-pressed", on ? "true" : "false");
          });

          var ord = this._dom.impOrder;
          this._clear(ord);
          if (parsed && parsed.mode === "text") {
            ord.style.cssText = "display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:10px";
            this._text("span", null, "Each line reads", ord).style.cssText = "font-size:13px; color:var(--mute)";
            [["artist-title", "Artist - Track"], ["title-artist", "Track - Artist"]].forEach(function (o) {
              var on = s.importOrder === o[0];
              var b = self._btn("pill" + (on ? " on" : ""), o[1], null, ord, function () { s.importOrder = o[0]; self._importReparse(); });
              b.setAttribute("aria-pressed", on ? "true" : "false");
            });
          } else ord.style.cssText = "";

          var err = this._dom.impError;
          this._clear(err);
          if (s.importError) {
            var e = this._text("div", null, s.importError, err);
            e.style.cssText = "margin-top:12px; padding:10px 14px; border-radius:12px; background:var(--bg); border:1px solid #ff8f8f; color:var(--text); font-size:13px";
          }

          var sum = this._dom.impSummary;
          this._clear(sum);
          if (parsed && parsed.items.length) {
            var line = this._el("div", null, sum);
            line.style.cssText = "display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; margin-top:12px";
            this._text("span", null, parsed.detected, line).style.cssText = "font-size:13px; color:var(--mute); flex:1 1 300px";
            if (s.importPhase === "idle") {
              this._btn("btn acc", "Find matches", "search", line, function () { self._importFindMatches(); }, 18);
            }
            if (parsed.truncated) {
              this._text("div", null, "Only the first " + lively.music.PlaylistIO.MAX_ROWS + " rows are read; " + parsed.truncated + " more were left out.", sum).style.cssText = "margin-top:6px; font-size:12.5px; color:#f2c14e";
            }
            if (parsed.groups.length > 1) {
              this._text("div", null, "This file holds " + parsed.groups.length + " playlists. Each one is imported as its own playlist.", sum).style.cssText = "margin-top:6px; font-size:13px; color:var(--mute)";
            }
          } else if (s.importText.trim()) {
            this._text("div", null, "No rows found yet.", sum).style.cssText = "margin-top:12px; font-size:13px; color:var(--mute)";
          }

          this._renderImportReview();
          this._renderImportSave();
        },

        // Debounced: matching updates rows many times a second.
        _renderImportSoon: function () {
          var self = this;
          if (this._importRenderTimer) return;
          this._importRenderTimer = setTimeout(function () {
            self._importRenderTimer = null;
            if (self.state.importOpen) self._renderImportReview();
          }, 120);
        },

        _renderImportReview: function () {
          var self = this;
          var s = this.state;
          var box = this._dom.impReview;
          this._clear(box);
          if (!s.importOpen || !s.importRows) return;
          var IO = lively.music.PlaylistIO;
          var counts = this._importCounts();
          var rows = s.importRows;

          this._stepHead(box, 2, "Check the matches");
          var bar = this._el("div", null, box);
          bar.style.cssText = "display:flex; flex-wrap:wrap; align-items:center; gap:8px 10px";
          var done = rows.filter(function (r) { return r.status !== "pending"; }).length;
          var how = s.importParsed && s.importParsed.idKind === "apple" ? "Matching by Apple id" : "Searching the catalog";
          this._text("span", null, s.importPhase === "matching" ? how + " · " + done + " of " + rows.length : how, bar).style.cssText = "font-size:13px; color:var(--mute)";
          var sp = this._el("span", null, bar);
          sp.style.flex = "1";
          [["ok", "matched", "#4fd69c"], ["check", "to check", "#f2c14e"], ["miss", "not found", "#ff8f8f"]].forEach(function (c) {
            var chip = self._text("span", "vis", counts[c[0]] + " " + c[1], bar);
            chip.style.background = c[2];
          });
          if (counts.unreachable) {
            var u = self._text("span", "vis", counts.unreachable + " unreachable", bar);
            u.style.background = "#b0abc0";
          }
          if (s.importPhase === "matching") {
            this._btn("pill", "Stop", "close", bar, function () { self._importCancel(); }, 14);
          } else if (counts.unreachable) {
            this._btn("pill", "Retry " + counts.unreachable, "refresh", bar, function () { self._importRetryUnreachable(); }, 14);
          }

          var list = this._el("div", null, box);
          list.style.cssText = "margin-top:10px; max-height:300px; overflow-y:auto; border:1px solid var(--line); border-radius:14px; background:var(--bg)";
          var ST = {
            ok: ["check", "#4fd69c"], check: ["priority_high", "#f2c14e"], miss: ["close", "#ff8f8f"],
            unreachable: ["cloud_off", "#b0abc0"], pending: ["hourglass_empty", "var(--surf2)"],
          };
          rows.forEach(function (r) {
            if (r.dropped) return;
            var eff = self._importEff(r);
            var row = self._el("div", null, list);
            row.style.cssText = "display:flex; flex-wrap:wrap; align-items:center; gap:6px 12px; padding:9px 12px; border-bottom:1px solid var(--line)";
            var dot = self._el("div", null, row);
            dot.style.cssText = "width:30px; height:30px; flex:none; border-radius:999px; display:flex; align-items:center; justify-content:center; color:#10131a; background:" + ST[eff][1];
            if (eff === "pending") dot.style.color = "var(--faint)";
            self._icon(ST[eff][0], 18, dot);
            var cov = self._el("div", null, row);
            cov.style.cssText = "width:38px; height:38px; flex:none; border-radius:8px";
            var hit = r.hit;
            self._setCover(cov, { coverUrl: hit ? self._artwork(hit.artworkUrl100, 100) : null, title: hit ? hit.collectionName : r.item.album || r.item.title });
            var col = self._el("div", null, row);
            col.style.cssText = "flex:1 1 220px; min-width:0";
            self._text("div", "ell", hit ? hit.trackName : r.item.title, col).style.fontWeight = "600";
            var sub = hit ? hit.artistName + (hit.collectionName ? " · " + hit.collectionName : "") : (r.item.artist || "") + (r.item.album ? " · " + r.item.album : "");
            self._text("div", "ell", sub, col).style.cssText = "font-size:12.5px; color:var(--mute)";
            self._text("span", null, r.note, row).style.cssText = "font-size:12.5px; color:var(--mute); flex:0 1 220px";
            if (r.status === "check" && !r.accepted) {
              self._btn("pill", "Use this", "check", row, function () { r.accepted = true; self._renderImportReview(); self._renderImportSave(); }, 14);
            }
            var rm = self._iconBtn("", "close", "Remove this line", row, function () { r.dropped = true; self._renderImportReview(); self._renderImportSave(); }, 18);
            rm.style.cssText = "width:30px; height:30px";
          });
        },

        _renderImportSave: function () {
          var self = this;
          var s = this.state;
          var box = this._dom.impSave;
          this._clear(box);
          if (!s.importOpen || !s.importRows || s.importPhase === "matching") return;
          var plan = this._importPlan();
          var parsed = s.importParsed;
          var saving = !!s.importSaving;
          var tracks = plan.reduce(function (n, g) { return n + (g.name.trim() ? g.rows.length : 0); }, 0);
          var lists = plan.filter(function (g) { return g.rows.length && g.name.trim(); }).length;

          this._stepHead(box, 3, "Save it");
          var multi = parsed.groups.length > 1;
          if (multi) {
            var gl = this._el("div", null, box);
            gl.style.cssText = "display:flex; flex-direction:column; gap:8px; margin-bottom:12px";
            plan.forEach(function (g) {
              var row = self._el("div", null, gl);
              row.style.cssText = "display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px";
              var wrap = self._el("div", null, row);
              wrap.style.cssText = "flex:1 1 240px; max-width:360px";
              var input = self._el("input", null, wrap);
              input.type = "text";
              input.value = g.name;
              input.setAttribute("aria-label", "Playlist name");
              input.disabled = saving;
              input.addEventListener("input", function () { s.importNames[g.key] = input.value; });
              self._text("span", "mono", g.rows.length + " of " + g.total + " matched", row).style.cssText = "font-size:12.5px; color:var(--mute)";
              var rm = self._iconBtn("", "close", "Skip this playlist", row, function () { s.importRemoved[g.key] = true; self._renderImportSave(); }, 18);
              rm.style.cssText = "width:30px; height:30px";
              rm.disabled = saving;
            });
          }

          var row = this._el("div", null, box);
          row.style.cssText = "display:flex; flex-wrap:wrap; align-items:center; gap:10px 14px";
          if (!multi) {
            var wrap = this._el("div", null, row);
            wrap.style.cssText = "flex:1 1 240px; max-width:360px";
            var input = this._el("input", null, wrap);
            input.type = "text";
            input.setAttribute("aria-label", "Playlist name");
            var g0 = plan[0];
            input.placeholder = "Imported playlist";
            input.value = g0 ? g0.name : "";
            input.disabled = saving;
            input.addEventListener("input", function () { if (g0) s.importNames[g0.key] = input.value; });
          }
          var vis = this._el("span", null, row);
          vis.setAttribute("role", "group");
          vis.setAttribute("aria-label", "Visibility");
          vis.style.cssText = "display:inline-flex; flex-wrap:wrap; gap:6px";
          ["private", "public"].forEach(function (v) {
            var on = s.importVis === v;
            var b = self._btn("pill" + (on ? " on" : ""), VIS_LABEL[v], VIS_ICON[v], vis, function () { s.importVis = v; self._renderImportSave(); }, 14);
            b.setAttribute("aria-pressed", on ? "true" : "false");
            b.disabled = saving;
          });
          var sp = this._el("span", null, row);
          sp.style.flex = "1";
          var label = saving ? "Saving…" : "Import " + tracks + (tracks === 1 ? " track" : " tracks") + (lists > 1 ? " into " + lists + " playlists" : "");
          var go = this._btn("btn acc", label, "upload", row, function () { self._importSave(); }, 18);
          go.disabled = saving || tracks === 0;

          var skipped = plan.reduce(function (n, g) { return n + (g.total - g.rows.length); }, 0);
          var note = saving ? s.importSaving : (tracks === 0 ? "Nothing is matched yet. Use “Use this” on a suggestion, or fix the list above." : (skipped ? skipped + (skipped === 1 ? " line is" : " lines are") + " skipped (not matched). " : "") + VIS_DESC[s.importVis]);
          this._text("div", null, note, box).style.cssText = "margin-top:8px; font-size:12.5px; color:var(--mute)";
        },

        _renderExportPanel: function (main, pl) {
          var self = this;
          var s = this.state;
          var d = this._exportData(pl);
          var box = this._el("div", null, main);
          box.style.cssText = "margin-top:20px; padding:16px 18px; background:var(--surf); border:1px solid var(--line); border-radius:16px";
          var head = this._el("div", null, box);
          head.style.cssText = "display:flex; flex-wrap:wrap; align-items:center; gap:10px 14px";
          this._text("span", "display", "Export playlist", head).style.cssText = "font-weight:700; font-size:17px";
          var grp = this._el("span", null, head);
          grp.setAttribute("role", "group");
          grp.setAttribute("aria-label", "File format");
          grp.style.cssText = "display:inline-flex; gap:6px";
          [["csv", "CSV"], ["txt", "Text"]].forEach(function (f) {
            var on = s.exportFmt === f[0];
            var b = self._btn("pill" + (on ? " on" : ""), f[1], null, grp, function () { s.exportFmt = f[0]; self._renderMain(); });
            b.setAttribute("aria-pressed", on ? "true" : "false");
          });
          this._el("span", null, head).style.flex = "1";
          this._btn("pill", "Copy", "content_copy", head, function () { self._copyExport(pl); }, 16);
          var a = this._el("a", "btn acc sm", head);
          a.href = "data:text/" + (d.isCsv ? "csv" : "plain") + ";charset=utf-8," + encodeURIComponent((d.isCsv ? "\uFEFF" : "") + d.body);
          a.download = d.filename;
          this._icon("download", 18, a);
          a.appendChild(document.createTextNode("Download " + d.filename));
          this._text("div", null, d.isCsv
            ? "One row per track, with the same columns a transfer-tool export uses. Opens in any spreadsheet, and the importer reads it straight back."
            : "One “Artist - Track” line per track. Paste it anywhere a list of songs is accepted.", box).style.cssText = "margin-top:6px; font-size:12.5px; color:var(--mute)";
          var lines = d.body.split("\n");
          var pre = this._el("div", "mono", box);
          pre.style.cssText = "margin-top:12px; max-height:170px; overflow:auto; padding:12px 14px; border-radius:12px; background:var(--bg); border:1px solid var(--line); font-size:12.5px; line-height:1.6; white-space:pre; color:var(--text)";
          pre.textContent = lines.slice(0, 14).join("\n") + (lines.length > 14 ? "\n… " + (lines.length - 14) + " more" : "");
        },

        _renderToast: function () {
          var t = this.state.toast;
          this._dom.toast.style.display = t ? "" : "none";
          this._dom.toast.textContent = t || "";
        },

        _renderQueue: function () {
          var self = this;
          var s = this.state;
          var pop = this._dom.queuePop;
          pop.style.display = s.queueOpen ? "" : "none";
          this._dom.pbQueueLabel.textContent = "Queue" + (s.queue.length ? " " + s.queue.length : "");
          this._clear(pop);
          if (!s.queueOpen) return;
          var head = this._el("div", null, pop);
          head.style.cssText = "display:flex; align-items:center; justify-content:space-between; padding:4px 8px 8px";
          this._text("span", "eyebrow", "Up next", head);
          if (s.queue.length) {
            this._btn("pill", "Clear", null, head, function () {
              self._stopAudio(); s.queue = []; s.qi = 0; s.playing = false; s.elapsed = 0;
              self._renderPlayer(); self._renderQueue();
            }).style.height = "26px";
          }
          if (!s.queue.length) this._text("div", null, "Nothing queued. Press play on an album or playlist.", pop).style.cssText = "padding:8px; color:var(--mute); font-size:13px";
          s.queue.forEach(function (t, i) {
            var b = self._el("button", "nav", pop);
            b.type = "button";
            b.style.height = "44px";
            if (i === s.qi) b.classList.add("on");
            var cov = self._el("div", null, b);
            cov.style.cssText = "width:32px; height:32px; flex:none; border-radius:6px";
            self._setCover(cov, { coverUrl: t.coverUrl, title: t.albumTitle || t.title });
            var col = self._el("div", null, b);
            col.style.cssText = "flex:1; min-width:0; text-align:left";
            self._text("div", "ell", t.title, col).style.cssText = "font-weight:600; color:" + (i === s.qi ? "var(--acc)" : "var(--text)") + "; font-size:13px";
            self._text("div", "ell", t.artist, col).style.cssText = "font-size:12px; color:var(--mute)";
            b.addEventListener("click", function () { self._playIndex(i); });
          });
        },

        _renderPlayer: function () {
          var s = this.state;
          var cur = this._current();
          var none = !cur;
          this._dom.pbPrev.disabled = none;
          this._dom.pbNext.disabled = none;
          this._dom.pbToggle.disabled = none;
          this._dom.pbSeek.disabled = none;
          this._dom.pbToggle.firstChild.textContent = s.playing ? "pause" : "play_arrow";
          this._dom.pbToggle.setAttribute("aria-label", s.playing ? "Pause" : "Play");
          this._dom.pbTitle.textContent = cur ? cur.title : "Nothing playing";
          this._dom.pbSub.textContent = cur ? cur.artist + (cur.albumTitle ? " · " + cur.albumTitle : "") : "Press play on an album or playlist";
          if (cur) this._setCover(this._dom.pbCover, { coverUrl: cur.coverUrl, title: cur.albumTitle || cur.title });
          else { this._dom.pbCover.style.backgroundImage = "none"; this._dom.pbCover.style.background = "var(--surf2)"; }
          this._tickPlayer();
          // Play/pause glyphs in the lists mirror the player state.
          if (this._nowPlayingKey !== (cur && cur.previewUrl) + ":" + s.playing) {
            this._nowPlayingKey = (cur && cur.previewUrl) + ":" + s.playing;
            this._renderMain();
            this._renderAlbum();
          }
        },

        // Progress only — runs on every timeupdate, so it must not rebuild DOM.
        _tickPlayer: function () {
          var s = this.state;
          var d = s.duration || 30;
          var pct = this._current() ? Math.min(100, (s.elapsed / d) * 100) : 0;
          this._dom.pbFill.style.width = pct + "%";
          this._dom.pbElapsed.textContent = fmtTime(s.elapsed);
          this._dom.pbTotal.textContent = fmtTime(d);
        },
      },
    );

    MusicClass.open = function (optPos) {
      var m = new lively.music.Music(lively.rect(0, 0, 1280, 820));
      m.setName("Music");
      m.openInWorld(optPos || lively.morphic.World.current().visibleBounds().center().subPt(lively.pt(640, 410)));
      // Re-fit and re-render now that the morph is genuinely attached:
      // _setup() runs during openInWorld's own addMorph step, before the
      // owner chain exists, so the first-pass title and position are stale.
      m._fitToWorld();
      m._renderHeader();
      return m;
    };
  }); // end module('lively.music.Music')
