/**
 * lively.gallery.Gallery
 *
 * A photo masonry gallery (variable-height tiles in flowing columns): the
 * first "world template" (see
 * core/lively/identity/WorldTemplateLauncher.js) — a preset layout a user
 * picks from WorldsBrowser.js's create-world flow, which pre-fills a fresh
 * world with this morph. Ported from a Claude Design canvas mock
 * (`Gallery Template.dc.html`, not real code — see gallery-template.md at
 * the repo root for the full design-decision log) into a working morph.
 *
 * Self-rendering morph (raw DOM owned directly, not a BuildSpec submorph
 * tree) — same pattern as lively.commerce.Shop: _buildChrome() builds a
 * persistent DOM tree once, state changes call targeted _render* methods
 * that mutate the stored element refs directly. See that file's own header
 * comment for the architecture this one copies.
 *
 * Storage: backed by lively.identity.fileCrypto's folder object type
 * (createFolder/addFileToFolder/fetchFolder/etc, extended in FileCrypto.js
 * to carry an optional `albums` array and per-file `caption`/`albumId`, and
 * a real 'public' visibility mode previously only supported for plain
 * files — see that file's history for the extension). The backing folder's
 * objId/handle are plain serialized Morph properties (galleryFolderObjId/
 * galleryHandle) so reopening the world finds the same folder again; the
 * live photo/album list is transient UI state, rebuilt from the folder on
 * every fresh render context.
 *
 * Privacy (public/private) is a real, owner-triggered migration — not a
 * metadata flip — since a public member blob is plaintext and a private
 * one is dek-encrypted; see FileCrypto.js's setFolderVisibility.
 *
 * Entry point:
 *   lively.gallery.Gallery.open(optWorldPosition)
 */

module("lively.gallery.Gallery")
  .requires()
  .toRun(function () {
    var ICON_UPLOAD =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"></path><path d="M6 10l6-6 6 6"></path><path d="M4 20h16"></path></svg>';
    var ICON_CLOSE =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="5" x2="19" y2="19"></line><line x1="19" y1="5" x2="5" y2="19"></line></svg>';
    var ICON_CHEVRON_LEFT =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>';
    var ICON_CHEVRON_RIGHT =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
    var ICON_TRASH =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>';
    var ICON_GRIP =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="6" r="1.6"></circle><circle cx="16" cy="6" r="1.6"></circle><circle cx="8" cy="12" r="1.6"></circle><circle cx="16" cy="12" r="1.6"></circle><circle cx="8" cy="18" r="1.6"></circle><circle cx="16" cy="18" r="1.6"></circle></svg>';
    var ICON_LOCK =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>';
    var ICON_GLOBE =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="3" y1="12" x2="21" y2="12"></line><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"></path></svg>';

    // Theme tokens ported verbatim from the approved mockup's
    // getThemeTokens() (gallery-template.md's artifact iteration log) —
    // reuse the exact hex/font values, not an approximation.
    var THEMES = {
      shop: {
        label: "Echo",
        bg: "#fdf0f5", surface: "#ffffff", card: "#fbe0ec",
        text: "#201e1d", textMuted: "#80676f", accent: "#e8497e", accent2: "#9a3a3a",
        divider: "rgba(32,30,29,0.14)", radiusSm: "8px", radiusMd: "16px", radiusLg: "26px",
        shadowSm: "0 2px 8px rgba(46,43,37,0.12)", shadowLg: "0 18px 44px rgba(46,43,37,0.3)",
        fontHeading: "'Caprasimo', system-ui, sans-serif", fontBody: "'Figtree', system-ui, sans-serif",
        headingWeight: "400", swatchA: "#e8497e", swatchB: "#7cb342",
        fontImport: "family=Caprasimo:wght@400&family=Figtree:wght@400;600;700",
      },
      neutral: {
        label: "Neutral",
        bg: "#f6f3ee", surface: "#ffffff", card: "#efe9df",
        text: "#201d19", textMuted: "#79705f", accent: "#c2592f", accent2: "#8a3a2b",
        divider: "rgba(32,29,25,0.14)", radiusSm: "6px", radiusMd: "12px", radiusLg: "20px",
        shadowSm: "0 2px 10px rgba(40,34,25,0.1)", shadowLg: "0 20px 48px rgba(40,34,25,0.26)",
        fontHeading: "'Fraunces', Georgia, serif", fontBody: "'Work Sans', system-ui, sans-serif",
        headingWeight: "600", swatchA: "#c2592f", swatchB: "#44546b",
        fontImport: "family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Work+Sans:wght@400;500;600",
      },
      darkroom: {
        label: "Darkroom",
        bg: "#000000", surface: "#1f1b18", card: "#272220",
        text: "#f3ece2", textMuted: "#a99c8e", accent: "#ff5c8a", accent2: "#c23d63",
        divider: "rgba(243,236,226,0.16)", radiusSm: "6px", radiusMd: "14px", radiusLg: "22px",
        shadowSm: "0 2px 10px rgba(0,0,0,0.45)", shadowLg: "0 22px 50px rgba(0,0,0,0.65)",
        fontHeading: "'Space Grotesk', system-ui, sans-serif", fontBody: "'IBM Plex Sans', system-ui, sans-serif",
        headingWeight: "600", swatchA: "#ff5c8a", swatchB: "#c23d63",
        fontImport: "family=Space+Grotesk:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600",
      },
    };
    var THEME_KEYS = ["shop", "neutral", "darkroom"];

    function themeCssBlock(key) {
      var t = THEMES[key];
      return (
        '.lk-gallery-viewport[data-theme="' + key + '"] {' +
        " --g-bg:" + t.bg + "; --g-surface:" + t.surface + "; --g-card:" + t.card + ";" +
        " --g-text:" + t.text + "; --g-text-muted:" + t.textMuted + ";" +
        " --g-accent:" + t.accent + "; --g-accent-2:" + t.accent2 + ";" +
        " --g-divider:" + t.divider + ";" +
        " --g-radius-sm:" + t.radiusSm + "; --g-radius-md:" + t.radiusMd + "; --g-radius-lg:" + t.radiusLg + ";" +
        " --g-shadow-sm:" + t.shadowSm + "; --g-shadow-lg:" + t.shadowLg + ";" +
        " --g-font-heading:" + t.fontHeading + "; --g-font-body:" + t.fontBody + "; --g-heading-weight:" + t.headingWeight + ";" +
        " }"
      );
    }

    // Every rule scoped under .lk-gallery-root/.lk-gallery-viewport so this
    // can't leak into the rest of the Lively world (Shop.js's own idiom).
    // Theme custom properties live on .lk-gallery-viewport (the OUTER node),
    // not .lk-gallery-root, because the lightbox backdrop is a sibling of
    // .lk-gallery-root (not a descendant) under the two-wrapper scroll split
    // below — scoping the vars to .lk-gallery-root alone would leave the
    // lightbox unthemed (same reasoning Shop.js's own CSS already follows
    // for its checkout dialog).
    var GALLERY_CSS = "" +
      "@import url('https://fonts.googleapis.com/css2?" +
      THEME_KEYS.map(function (k) { return THEMES[k].fontImport; }).join("&") +
      "&display=swap');" +
      THEME_KEYS.map(themeCssBlock).join("") +
      ".lk-gallery-viewport {" +
      "  background:var(--g-bg); color:var(--g-text); font-family:var(--g-font-body);" +
      "  font-size:14px; line-height:1.5; height:100%; position:relative; overflow:hidden; box-sizing:border-box;" +
      "  transition:background 0.2s ease, color 0.2s ease;" +
      "}" +
      // .lk-gallery-root is the actual scrolling pane, nested inside the
      // fixed-height .lk-gallery-viewport — the lightbox backdrop is a
      // sibling of .lk-gallery-root (appended directly to the viewport), so
      // its position:absolute;inset:0 covers the morph's visible viewport
      // exactly regardless of scroll offset (Shop.js's documented fix).
      ".lk-gallery-root { height:100%; overflow-y:auto; position:relative; scrollbar-width:thin; scrollbar-color:var(--g-accent) var(--g-card); }" +
      ".lk-gallery-root::-webkit-scrollbar { width:10px; }" +
      ".lk-gallery-root::-webkit-scrollbar-track { background:var(--g-card); }" +
      ".lk-gallery-root::-webkit-scrollbar-thumb { background:var(--g-accent); border-radius:999px; border:2px solid var(--g-card); }" +
      ".lk-gallery-viewport, .lk-gallery-viewport *, .lk-gallery-viewport *::before, .lk-gallery-viewport *::after { box-sizing:border-box; }" +
      ".lk-gallery-viewport h1, .lk-gallery-viewport h2, .lk-gallery-viewport h3 {" +
      "  font-family:var(--g-font-heading); font-weight:var(--g-heading-weight); letter-spacing:-0.01em; margin:0;" +
      "}" +
      ".lk-gallery-viewport h1 { font-size:30px } .lk-gallery-viewport h2 { font-size:20px } .lk-gallery-viewport h3 { font-size:15px }" +
      ".lk-gallery-viewport .text-muted { color:var(--g-text-muted) }" +
      ".lk-gallery-viewport .btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; cursor:pointer;" +
      "  font-family:var(--g-font-body); font-weight:600; font-size:13px; color:var(--g-text); background:transparent;" +
      "  border:1px solid transparent; padding:8px 16px; border-radius:999px; white-space:nowrap;}" +
      ".lk-gallery-viewport .btn:disabled { opacity:0.45; cursor:not-allowed }" +
      ".lk-gallery-viewport .btn-primary { background:var(--g-accent); color:#fff }" +
      ".lk-gallery-viewport .btn-primary:hover { filter:brightness(0.92) }" +
      ".lk-gallery-viewport .btn-secondary { border-color:var(--g-divider); background:var(--g-surface) }" +
      ".lk-gallery-viewport .btn-secondary:hover { background:var(--g-card) }" +
      ".lk-gallery-viewport .btn-secondary.is-active { background:var(--g-accent); color:#fff; border-color:transparent }" +
      ".lk-gallery-viewport .btn-ghost { color:var(--g-text-muted); border:none; background:transparent; padding:4px 8px }" +
      ".lk-gallery-viewport .btn-ghost:hover { color:var(--g-text) }" +
      ".lk-gallery-viewport .btn-icon { width:30px; height:30px; padding:0; border-radius:50% }" +
      ".lk-gallery-viewport .pill { display:inline-flex; align-items:center; gap:6px; height:30px; padding:0 14px; border-radius:999px; font-size:12px; font-weight:600; cursor:pointer; border:1px solid var(--g-divider); background:var(--g-surface); }" +
      ".lk-gallery-viewport .pill.is-active { background:var(--g-accent); color:#fff; border-color:transparent }" +
      ".lk-gallery-viewport .input { width:100%; min-height:34px; padding:6px 12px; font:inherit; font-size:13px; color:var(--g-text);" +
      "  background:var(--g-surface); border:1px solid var(--g-divider); border-radius:999px;}" +
      ".lk-gallery-viewport .input:focus-visible { outline:2px solid var(--g-accent); outline-offset:0 }" +
      ".lk-gallery-viewport .hdr { position:sticky; top:0; z-index:10; background:var(--g-bg); border-bottom:1px solid var(--g-divider);" +
      "  padding:18px 28px; display:flex; flex-direction:column; gap:14px; }" +
      ".lk-gallery-viewport .hdr-top { display:flex; align-items:center; gap:14px; flex-wrap:wrap }" +
      ".lk-gallery-viewport .hdr-spacer { flex:1 }" +
      ".lk-gallery-viewport .swatch-row { display:flex; gap:6px; align-items:center; margin-right:6px }" +
      ".lk-gallery-viewport .swatch { width:22px; height:22px; border-radius:50%; cursor:pointer; border:2px solid transparent; display:grid; grid-template-columns:1fr 1fr; overflow:hidden; }" +
      ".lk-gallery-viewport .swatch.is-active { border-color:var(--g-text) }" +
      ".lk-gallery-viewport .swatch span { display:block }" +
      ".lk-gallery-viewport .album-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap }" +
      ".lk-gallery-viewport .new-album-form { display:inline-flex; align-items:center; gap:6px }" +
      ".lk-gallery-viewport .new-album-form .input { width:140px; min-height:28px; padding:4px 10px }" +
      ".lk-gallery-viewport .gal-main { max-width:1280px; margin:0 auto; padding:24px 28px 60px }" +
      ".lk-gallery-viewport .gal-empty { text-align:center; padding:80px 20px; color:var(--g-text-muted) }" +
      ".lk-gallery-viewport .gal-masonry { column-count:4; column-gap:18px; }" +
      "@media (max-width:1180px) { .lk-gallery-viewport .gal-masonry { column-count:3 } }" +
      "@media (max-width:820px)  { .lk-gallery-viewport .gal-masonry { column-count:2 } }" +
      "@media (max-width:520px)  { .lk-gallery-viewport .gal-masonry { column-count:1 } }" +
      ".lk-gallery-viewport .gal-tile { break-inside:avoid; margin-bottom:18px; position:relative; isolation:isolate; cursor:pointer;" +
      "  border-radius:var(--g-radius-md); overflow:hidden; background:var(--g-card); box-shadow:var(--g-shadow-sm); transition:transform 0.15s ease; }" +
      ".lk-gallery-viewport .gal-tile:hover { transform:translateY(-2px) }" +
      ".lk-gallery-viewport .gal-tile.is-dragging { opacity:0.4 }" +
      ".lk-gallery-viewport .gal-tile.is-drop-target { outline:3px solid var(--g-accent); outline-offset:-3px }" +
      ".lk-gallery-viewport .gal-tile img { display:block; width:100%; height:auto }" +
      ".lk-gallery-viewport .gal-cap { position:absolute; left:0; right:0; bottom:0; padding:10px 12px 8px; color:#fff;" +
      "  background:linear-gradient(to top, rgba(0,0,0,0.65), transparent); font-size:12px; opacity:0; transition:opacity 0.15s ease; pointer-events:none; }" +
      ".lk-gallery-viewport .gal-tile:hover .gal-cap { opacity:1 }" +
      ".lk-gallery-viewport .gal-grip { position:absolute; top:8px; left:8px; width:26px; height:26px; border-radius:50%;" +
      "  background:rgba(0,0,0,0.55); color:#fff; display:flex; align-items:center; justify-content:center; cursor:grab; z-index:2; }" +
      ".lk-gallery-viewport .dialog-backdrop { position:absolute; inset:0; display:grid; place-items:center; padding:24px;" +
      "  background:rgba(10,8,6,0.78); z-index:30;}" +
      ".lk-gallery-viewport .lightbox { width:min(900px, 100%); max-height:100%; display:flex; flex-direction:column; background:var(--g-surface);" +
      "  border-radius:var(--g-radius-lg); overflow:hidden; box-shadow:var(--g-shadow-lg); color:var(--g-text); }" +
      ".lk-gallery-viewport .lightbox-img-wrap { position:relative; background:#000; display:flex; align-items:center; justify-content:center; max-height:60vh; overflow:hidden }" +
      ".lk-gallery-viewport .lightbox-img-wrap img { max-width:100%; max-height:60vh; object-fit:contain; display:block }" +
      ".lk-gallery-viewport .lightbox-nav { position:absolute; top:50%; transform:translateY(-50%); width:36px; height:36px; border-radius:50%;" +
      "  background:rgba(0,0,0,0.5); color:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; }" +
      ".lk-gallery-viewport .lightbox-nav.prev { left:10px } .lk-gallery-viewport .lightbox-nav.next { right:10px }" +
      ".lk-gallery-viewport .lightbox-close { position:absolute; top:10px; right:10px; width:32px; height:32px; border-radius:50%;" +
      "  background:rgba(0,0,0,0.5); color:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; }" +
      ".lk-gallery-viewport .lightbox-body { padding:16px 20px 20px; display:flex; flex-direction:column; gap:12px; overflow-y:auto }" +
      ".lk-gallery-viewport .lightbox-albums { display:flex; gap:6px; flex-wrap:wrap }" +
      ".lk-gallery-viewport .lightbox-actions { display:flex; justify-content:space-between; align-items:center; margin-top:4px }" +
      ".lk-gallery-viewport .upload-progress { font-size:12px; color:var(--g-text-muted) }" +
      ".lk-gallery-viewport .gal-gate { padding:60px 20px; text-align:center; color:var(--g-text-muted) }" +
      ".lk-gallery-viewport input[type=file] { display:none }";

    var GalleryClass = lively.morphic.Box.subclass(
      "lively.gallery.Gallery",

      "serialization",
      {
        // state/_dom are rebuilt from scratch in _setup() on every fresh
        // render context; _identityConnection is a live Connection to the
        // identity singleton (Shop.js's exact _identityConnection bug class
        // — omitting it broke every republished copy once). galleryFolderObjId/
        // galleryHandle/galleryTheme are deliberately real (serialized)
        // Morph properties, not state — they're the only things this morph
        // needs to remember across a reload to find its own backing folder
        // again.
        doNotSerialize: ["state", "_dom", "_identityConnection"],
      },

      "initialization",
      {
        DEFAULT_EXTENT: { w: 1180, h: 780 },

        initialize: function ($super, optExtent) {
          $super(optExtent || lively.rect(0, 0, 1180, 780));
          this.setFill(null);
          this.setBorderWidth(0);
          // A plain Box defaults to draggable/droppable/grabbable; this
          // morph is a full-viewport app template (header buttons, tiles,
          // pills all live as plain DOM inside its own single shapeNode,
          // not as separate submorphs, so there's only this one set of
          // flags to clear — see CLAUDE.md's "every visible child
          // individually" note, which only applies to a real submorph
          // tree). Without this, any click-with-a-twitch on a header
          // button or photo tile risks being eaten as a drag of the whole
          // gallery instead of firing its handler, and now that
          // _fitToWorld()/onWorldResize keep it pinned to the world, a
          // stray drag would visibly fight the pin on the next resize.
          this.disableDragging();
          this.disableDropping();
          this.disableGrabbing();
        },

        _setup: function () {
          this._dom = {};
          this.state = {
            theme: this.galleryTheme || "shop",
            albums: [],
            activeAlbum: "all",
            photos: [],
            reorderMode: false,
            lightboxId: null,
            draftCaption: "",
            dragId: null,
            uploading: false,
            creatingAlbum: false,
            isOwner: false,
            loaded: false,
          };
          this._fitToWorld();
          this._buildChrome();
          this._renderAll();
          this._bindIdentity();
          this._ensureFolder();
        },

        prepareForNewRenderContext: function ($super, renderCtx) {
          $super(renderCtx);
          this._setup();
        },

        remove: function ($super) {
          this._unbindIdentity();
          $super();
        },
      },

      "layout",
      {
        // Fills the whole world viewport rather than sitting at a fixed
        // construction-time extent — matches the window-resize idiom
        // MobileInterface.js's resizeWithWorld/MenuBar.js's onWorldResize
        // already use elsewhere in this codebase. Run once up front (both
        // fresh creation and every reload go through _setup) and again on
        // every real onWorldResize dispatch (Events.js calls this on every
        // morph in the world when the browser window resizes).
        _fitToWorld: function () {
          if (typeof $world === "undefined" || !$world) return;
          var vb = $world.visibleBounds();
          this.setPosition(vb.topLeft());
          this.setExtent(vb.extent());
        },
        onWorldResize: function () {
          lively.lang.fun.debounceNamed(this.id + "-gallery-world-resize", 150, this._fitToWorld.bind(this))();
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
        _svgIcon: function (svgString, parent) {
          var wrap = document.createElement("span");
          wrap.style.display = "inline-flex";
          wrap.innerHTML = svgString; // always a hardcoded literal above, never user data
          if (parent) parent.appendChild(wrap);
          return wrap;
        },
        _clear: function (el) {
          while (el.firstChild) el.removeChild(el.firstChild);
        },
      },

      "identity",
      {
        _currentUser: function () {
          if (typeof lively === "undefined" || !lively.identity || !lively.identity.did) return null;
          return lively.identity.did.currentUser();
        },
        // $world.name is NOT the real assigned display name — it's a
        // plain Morph property that stays at its generic default and is
        // never synced from the envelope on load (confirmed by
        // WorldTemplateLauncher.js's own _saveCurrentWorld comment, which
        // has to work around this same gap by preserving the prior
        // envelope's name instead of trusting $world.name). The actual
        // source of truth is document.title: IdentityServer.js's
        // buildWorldPage sets it server-side from envelope.state.name
        // (the name the user typed in WorldsBrowser.js's create form),
        // and SignedSerializer.js's own save path documents this same
        // precedence ("prefer document.title, which buildWorldPage sets
        // from state.name"). bootstrap.js never touches document.title
        // afterward, so it stays correct for the life of the page.
        _worldName: function () {
          var t = document.title;
          var isDefault = !t || t === "world" || t === "Lively" || t === "untitled world";
          return isDefault ? "Gallery" : t;
        },
        _bindIdentity: function () {
          if (typeof lively === "undefined" || !lively.bindings || !lively.identity || !lively.identity.did) return;
          var self = this;
          this._identityConnection = lively.bindings.connect(lively.identity.did, "identityChanged", self, "_onIdentityChanged");
          // restoreSession()'s boot-time async resolve can land before this
          // morph even exists, so the connect() above alone can miss it —
          // same race Shop.js's own _bindIdentity documents and works
          // around the same way.
          if (lively.identity.did.restoreSession) {
            lively.identity.did.restoreSession(function () { self._onIdentityChanged(); });
          }
        },
        _unbindIdentity: function () {
          if (this._identityConnection && this._identityConnection.disconnect) this._identityConnection.disconnect();
          this._identityConnection = null;
        },
        _onIdentityChanged: function () {
          // A freshly-known user might now be able to create/own the
          // backing folder (first load before restoreSession resolved), or
          // ownership of an already-loaded one might now be computable.
          if (!this.state.loaded) this._ensureFolder();
          else this._recomputeOwnerAndRender();
        },
        _recomputeOwnerAndRender: function () {
          var user = this._currentUser();
          this.state.isOwner = !!(user && this.galleryHandle && user.handle === this.galleryHandle);
          this._renderAll();
        },
      },

      "chrome building",
      {
        _buildChrome: function () {
          if (!document.getElementById("gallery-styles")) {
            var styleTag = document.createElement("style");
            styleTag.id = "gallery-styles";
            styleTag.textContent = GALLERY_CSS;
            document.head.appendChild(styleTag);
          }

          var shapeNode = this.renderContext().shapeNode;
          shapeNode.innerHTML = "";
          shapeNode.style.overflow = "hidden";

          var viewport = this._el("div", "lk-gallery-viewport", shapeNode);
          viewport.dataset.theme = this.state.theme;
          this._dom.viewport = viewport;
          var root = this._el("div", "lk-gallery-root", viewport);
          this._dom.root = root;

          this._buildHeader(root);
          this._buildMain(root);
          this._buildLightbox(viewport);
        },

        _buildHeader: function (root) {
          var self = this;
          var hdr = this._el("div", "hdr", root);

          var top = this._el("div", "hdr-top", hdr);
          this._dom.titleEl = this._text("h1", null, this._worldName(), top);

          this._dom.visibilityPill = this._el("span", "pill", top);
          this._dom.visibilityPill.addEventListener("click", function () { self._onClickVisibilityPill(); });

          this._dom.countLabel = this._text("span", "text-muted", "", top);

          var spacer = this._el("div", "hdr-spacer", top);

          var swatchRow = this._el("div", "swatch-row", top);
          this._dom.swatches = {};
          THEME_KEYS.forEach(function (key) {
            var t = THEMES[key];
            var sw = self._el("div", "swatch", swatchRow);
            sw.title = t.label;
            self._el("span", null, sw).style.background = t.swatchA;
            self._el("span", null, sw).style.background = t.swatchB;
            sw.addEventListener("click", function () { self._setTheme(key); });
            self._dom.swatches[key] = sw;
          });

          this._dom.reorderBtn = this._text("button", "btn btn-secondary", "Reorder", top);
          this._dom.reorderBtn.addEventListener("click", function () { self._toggleReorderMode(); });

          var uploadWrap = this._el("span", null, top);
          this._dom.uploadBtn = this._text("button", "btn btn-primary", "", uploadWrap);
          this._svgIcon(ICON_UPLOAD, this._dom.uploadBtn);
          this._dom.uploadBtn.appendChild(document.createTextNode(" Add Photos"));
          var fileInput = this._el("input", null, uploadWrap);
          fileInput.type = "file";
          fileInput.accept = "image/*";
          fileInput.multiple = true;
          this._dom.fileInput = fileInput;
          this._dom.uploadBtn.addEventListener("click", function () { fileInput.click(); });
          fileInput.addEventListener("change", function () {
            if (fileInput.files && fileInput.files.length) self._onPickFiles(fileInput.files);
            fileInput.value = "";
          });

          this._dom.uploadProgress = this._text("span", "upload-progress", "", top);

          var albumRow = this._el("div", "album-row", hdr);
          this._dom.albumRow = albumRow;
        },

        _buildMain: function (root) {
          var main = this._el("div", "gal-main", root);
          this._dom.main = main;
          this._dom.gate = this._el("div", "gal-gate", main);
          this._text("p", null, "Loading gallery…", this._dom.gate);
          this._dom.empty = this._el("div", "gal-empty", main);
          this._dom.empty.style.display = "none";
          this._text("h3", null, "No photos yet", this._dom.empty);
          this._text("p", "text-muted", "Add some photos to get started.", this._dom.empty);
          var grid = this._el("div", "gal-masonry", main);
          grid.style.display = "none";
          this._dom.grid = grid;
        },

        _buildLightbox: function (viewport) {
          var self = this;
          var backdrop = this._el("div", "dialog-backdrop", viewport);
          backdrop.style.display = "none";
          backdrop.addEventListener("mousedown", function (e) {
            if (e.target === backdrop) self._closeLightbox();
          });
          this._dom.lightboxBackdrop = backdrop;

          var box = this._el("div", "lightbox", backdrop);
          var imgWrap = this._el("div", "lightbox-img-wrap", box);
          this._dom.lightboxImg = this._el("img", null, imgWrap);
          this._dom.lightboxImg.src = "";

          var prevBtn = this._el("div", "lightbox-nav prev", imgWrap);
          this._svgIcon(ICON_CHEVRON_LEFT, prevBtn);
          prevBtn.addEventListener("click", function () { self._lightboxStep(-1); });

          var nextBtn = this._el("div", "lightbox-nav next", imgWrap);
          this._svgIcon(ICON_CHEVRON_RIGHT, nextBtn);
          nextBtn.addEventListener("click", function () { self._lightboxStep(1); });

          var closeBtn = this._el("div", "lightbox-close", imgWrap);
          this._svgIcon(ICON_CLOSE, closeBtn);
          closeBtn.addEventListener("click", function () { self._closeLightbox(); });

          var body = this._el("div", "lightbox-body", box);
          var captionInput = this._el("input", "input", body);
          captionInput.type = "text";
          captionInput.placeholder = "Add a caption…";
          captionInput.addEventListener("input", function () { self._onCaptionInput(captionInput.value); });
          this._dom.lightboxCaption = captionInput;

          this._dom.lightboxAlbums = this._el("div", "lightbox-albums", body);

          var actions = this._el("div", "lightbox-actions", body);
          var delBtn = this._text("button", "btn btn-ghost", "", actions);
          this._svgIcon(ICON_TRASH, delBtn);
          delBtn.appendChild(document.createTextNode(" Delete"));
          delBtn.addEventListener("click", function () { self._deleteCurrentPhoto(); });
          this._dom.lightboxDeleteBtn = delBtn;

          this._dom.lightboxPosLabel = this._text("span", "text-muted", "", actions);
        },
      },

      "storage",
      {
        _ensureFolder: function () {
          var self = this;
          var user = this._currentUser();

          if (this.galleryFolderObjId && this.galleryHandle) {
            return this._loadFolder();
          }
          if (!user) return; // wait for _onIdentityChanged to retry

          lively.identity.fileCrypto.createFolder("Gallery", { visibility: "private" }, function (err, result) {
            if (err) {
              console.warn("[Gallery] could not create backing folder:", err.message);
              return;
            }
            self.galleryFolderObjId = result.objId;
            self.galleryHandle = user.handle;
            self._loadFolder();
            // WorldTemplateLauncher's own _saveCurrentWorld() call (fired
            // right after Gallery.open() returns, per its "shop" case) runs
            // BEFORE this async createFolder ceremony resolves — confirmed
            // live: that save captured the morph with no
            // galleryFolderObjId/galleryHandle set at all, so every reload
            // saw neither, treated the gallery as brand new, and created a
            // fresh orphan folder each time. Saving again here, once the
            // folder genuinely exists, is what actually persists the
            // pointer — mirrors _saveCurrentWorld's own "save once there's
            // real content" principle, just triggered by this async step
            // completing instead of a synchronous .open() return.
            if (typeof lively !== "undefined" && lively.identity && lively.identity.WorldTemplateLauncher && lively.identity.WorldTemplateLauncher._saveCurrentWorld) {
              lively.identity.WorldTemplateLauncher._saveCurrentWorld();
            }
          });
        },

        _loadFolder: function () {
          var self = this;
          lively.identity.fileCrypto.fetchFolder(this.galleryHandle, this.galleryFolderObjId, function (err, folder) {
            if (err) {
              console.warn("[Gallery] could not load backing folder:", err.message);
              self._dom.gate.textContent = "";
              self._text("p", null, "Could not load this gallery.", self._dom.gate);
              return;
            }
            self.state.loaded = true;
            self.state.photos = folder.files.slice();
            self.state.albums = folder.albums.slice();
            self.state.visibility = folder.envelope.visibility;
            self.state.isOwner = folder.isOwner;
            self._dom.gate.style.display = "none";
            self._renderAll();
          });
        },

        _withFreshFolder: function (thenDo) {
          lively.identity.fileCrypto.fetchFolder(this.galleryHandle, this.galleryFolderObjId, thenDo);
        },
      },

      "theme",
      {
        _setTheme: function (key) {
          this.state.theme = key;
          this.galleryTheme = key;
          this._dom.viewport.dataset.theme = key;
          this._renderSwatches();
        },
      },

      "privacy",
      {
        _onClickVisibilityPill: function () {
          if (!this.state.isOwner || !this.state.loaded) return;
          var next = this.state.visibility === "public" ? "private" : "public";
          var self = this;
          this.state.visibility = next + "-pending";
          this._renderHeader();
          lively.identity.fileCrypto.setFolderVisibility(this.galleryHandle, this.galleryFolderObjId, next, {}, function (err) {
            if (err) {
              console.warn("[Gallery] could not change visibility:", err.message);
              self._loadFolder();
              return;
            }
            self._loadFolder();
          });
        },
      },

      "albums",
      {
        _setActiveAlbum: function (id) {
          this.state.activeAlbum = id;
          this._renderAlbumRow();
          this._renderGrid();
        },
        _startNewAlbum: function () {
          this.state.creatingAlbum = true;
          this._renderAlbumRow();
          if (this._dom.albumDraftInput) this._dom.albumDraftInput.focus();
        },
        _cancelNewAlbum: function () {
          this.state.creatingAlbum = false;
          this._renderAlbumRow();
        },
        _confirmNewAlbum: function (name) {
          name = (name || "").trim();
          this.state.creatingAlbum = false;
          if (!name) { this._renderAlbumRow(); return; }
          var id = "album-" + Date.now();
          var newAlbums = this.state.albums.concat([{ id: id, name: name }]);
          var self = this;
          lively.identity.fileCrypto.setFolderAlbums(this.galleryHandle, this.galleryFolderObjId, newAlbums, function (err) {
            if (err) { console.warn("[Gallery] could not save album:", err.message); return; }
            self.state.albums = newAlbums;
            self.state.activeAlbum = id;
            self._renderAlbumRow();
            self._renderGrid();
          });
        },
      },

      "upload",
      {
        _onPickFiles: function (fileList) {
          var files = Array.prototype.slice.call(fileList);
          if (!files.length) return;
          var self = this;
          var albumId = this.state.activeAlbum === "all" ? null : this.state.activeAlbum;
          var total = files.length;
          var done = 0;
          this.state.uploading = true;
          this._renderUploadProgress(done, total);

          function next(i) {
            if (i >= files.length) {
              self.state.uploading = false;
              self._renderUploadProgress(0, 0);
              self._withFreshFolder(function (err, folder) {
                if (err) return;
                self.state.photos = folder.files.slice();
                self._renderGrid();
                self._renderHeader();
              });
              return;
            }
            var f = files[i];
            lively.identity.fileCrypto.addFileToFolder(self.galleryHandle, self.galleryFolderObjId, f, {
              name: f.name,
              caption: f.name.replace(/\.[^.]+$/, ""),
              albumId: albumId,
            }, function (err) {
              if (err) console.warn("[Gallery] upload failed for", f.name, err.message);
              done += 1;
              self._renderUploadProgress(done, total);
              next(i + 1);
            });
          }
          next(0);
        },
      },

      "reorder",
      {
        _toggleReorderMode: function () {
          this.state.reorderMode = !this.state.reorderMode;
          this._renderHeader();
          this._renderGrid();
        },
        _onTileDragStart: function (photoId, evt) {
          this.state.dragId = photoId;
          evt.dataTransfer.effectAllowed = "move";
          evt.dataTransfer.setData("text/plain", photoId);
        },
        // A plain tile.addEventListener("dragover"/"drop") never fires:
        // lively.morphic.World handles those in capture phase on its own
        // shapeNode and stops them first. It does delegate to the morph under
        // the cursor's onHTML5Drag/onHTML5Drop, so these two (the same
        // pattern as FilesBrowser.js) hit-test the tiles themselves via
        // data-photo-id.
        onHTML5Drag: function (evt) {
          if (!this.state || !this.state.dragId) return false;
          var el = this._tileElAt(evt.clientX, evt.clientY);
          if (this._dragHoverEl && this._dragHoverEl !== el) {
            this._dragHoverEl.classList.remove("is-drop-target");
            this._dragHoverEl = null;
          }
          if (!el) return false;
          evt.preventDefault();
          if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
          el.classList.add("is-drop-target");
          this._dragHoverEl = el;
          return true;
        },
        onHTML5Drop: function (evt) {
          if (this._dragHoverEl) { this._dragHoverEl.classList.remove("is-drop-target"); this._dragHoverEl = null; }
          if (!this.state || !this.state.dragId) return false;
          var el = this._tileElAt(evt.clientX, evt.clientY);
          if (!el) { this.state.dragId = null; return false; }
          evt.preventDefault();
          this._onTileDrop(el.getAttribute("data-photo-id"));
          return true;
        },
        _tileElAt: function (x, y) {
          var el = document.elementFromPoint(x, y);
          return el && el.closest ? el.closest(".gal-tile[data-photo-id]") : null;
        },
        _onTileDrop: function (targetId) {
          var dragId = this.state.dragId;
          this.state.dragId = null;
          if (!dragId || dragId === targetId) return;
          var photos = this.state.photos;
          var fromIdx = photos.findIndex(function (p) { return p.id === dragId; });
          var toIdx = photos.findIndex(function (p) { return p.id === targetId; });
          if (fromIdx === -1 || toIdx === -1) return;
          // Swap-based reorder (dragging A onto B swaps their positions, not
          // a full insert-at-index) — same documented simplification the
          // approved mockup shipped with.
          var tmp = photos[fromIdx];
          photos[fromIdx] = photos[toIdx];
          photos[toIdx] = tmp;
          this._renderGrid();
          var self = this;
          lively.identity.fileCrypto.reorderFolderFiles(this.galleryHandle, this.galleryFolderObjId, photos.map(function (p) { return p.id; }), function (err) {
            if (err) console.warn("[Gallery] could not persist reorder:", err.message);
          });
        },
      },

      "lightbox",
      {
        _visiblePhotos: function () {
          var albumId = this.state.activeAlbum;
          if (albumId === "all") return this.state.photos;
          return this.state.photos.filter(function (p) { return p.albumId === albumId; });
        },
        _openLightbox: function (photoId) {
          var photo = this.state.photos.filter(function (p) { return p.id === photoId; })[0];
          this.state.lightboxId = photoId;
          this.state.draftCaption = photo ? (photo.caption || "") : "";
          this._renderLightbox();
        },
        _closeLightbox: function () {
          this.state.lightboxId = null;
          this._renderLightbox();
        },
        _lightboxStep: function (delta) {
          var list = this._visiblePhotos();
          var idx = list.findIndex(function (p) { return p.id === this.state.lightboxId; }, this);
          if (idx === -1 || !list.length) return;
          var nextIdx = (idx + delta + list.length) % list.length;
          var photo = list[nextIdx];
          this.state.lightboxId = photo.id;
          this.state.draftCaption = photo.caption || "";
          this._renderLightbox();
        },
        _onCaptionInput: function (value) {
          this.state.draftCaption = value;
          var self = this;
          clearTimeout(this._captionSaveTimer);
          this._captionSaveTimer = setTimeout(function () { self._saveCaption(); }, 500);
        },
        _saveCaption: function () {
          var id = this.state.lightboxId;
          if (!id) return;
          var photo = this.state.photos.filter(function (p) { return p.id === id; })[0];
          if (!photo) return;
          photo.caption = this.state.draftCaption;
          var self = this;
          lively.identity.fileCrypto.updateFolderFileMeta(this.galleryHandle, this.galleryFolderObjId, id, { caption: this.state.draftCaption }, function (err) {
            if (err) console.warn("[Gallery] could not save caption:", err.message);
            else self._renderGrid();
          });
        },
        _assignToAlbum: function (albumId) {
          var id = this.state.lightboxId;
          if (!id) return;
          var photo = this.state.photos.filter(function (p) { return p.id === id; })[0];
          if (!photo) return;
          photo.albumId = albumId;
          var self = this;
          lively.identity.fileCrypto.updateFolderFileMeta(this.galleryHandle, this.galleryFolderObjId, id, { albumId: albumId }, function (err) {
            if (err) console.warn("[Gallery] could not reassign album:", err.message);
            self._renderLightbox();
            self._renderGrid();
          });
        },
        _deleteCurrentPhoto: function () {
          var id = this.state.lightboxId;
          if (!id) return;
          var self = this;
          lively.identity.fileCrypto.removeFileFromFolder(this.galleryHandle, this.galleryFolderObjId, id, function (err) {
            if (err) { console.warn("[Gallery] could not delete photo:", err.message); return; }
            self.state.photos = self.state.photos.filter(function (p) { return p.id !== id; });
            self.state.lightboxId = null;
            self._renderLightbox();
            self._renderGrid();
            self._renderHeader();
          });
        },
      },

      "rendering",
      {
        _renderAll: function () {
          this._renderHeader();
          this._renderAlbumRow();
          this._renderGrid();
          this._renderLightbox();
        },

        _renderHeader: function () {
          var self = this;
          if (this._dom.titleEl) this._dom.titleEl.textContent = this._worldName();
          var isOwner = this.state.isOwner;
          var vis = this.state.visibility;
          var pill = this._dom.visibilityPill;
          this._clear(pill);
          if (!this.state.loaded) {
            pill.textContent = "";
            pill.style.cursor = "default";
          } else {
            var isPublic = (vis || "private").indexOf("public") === 0;
            this._svgIcon(isPublic ? ICON_GLOBE : ICON_LOCK, pill);
            pill.appendChild(document.createTextNode(" " + (vis === "public-pending" ? "Making public…" : vis === "private-pending" ? "Making private…" : (isPublic ? "Public" : "Private"))));
            pill.style.cursor = isOwner && vis.indexOf("pending") === -1 ? "pointer" : "default";
            pill.style.opacity = vis.indexOf("pending") === -1 ? "1" : "0.6";
          }

          this._dom.countLabel.textContent = this.state.loaded
            ? (this.state.photos.length + (this.state.photos.length === 1 ? " photo" : " photos"))
            : "";

          this._dom.reorderBtn.style.display = isOwner ? "" : "none";
          this._dom.reorderBtn.className = this.state.reorderMode ? "btn btn-secondary is-active" : "btn btn-secondary";

          this._dom.uploadBtn.parentNode.style.display = isOwner ? "" : "none";
          this._dom.uploadBtn.disabled = this.state.uploading;

          this._renderSwatches();
        },

        _renderSwatches: function () {
          var self = this;
          THEME_KEYS.forEach(function (key) {
            var sw = self._dom.swatches[key];
            sw.className = key === self.state.theme ? "swatch is-active" : "swatch";
          });
        },

        _renderUploadProgress: function (done, total) {
          this._dom.uploadProgress.textContent = total ? ("Uploading " + done + "/" + total + "…") : "";
        },

        _renderAlbumRow: function () {
          var self = this;
          var row = this._dom.albumRow;
          this._clear(row);

          var allPill = this._text("span", this.state.activeAlbum === "all" ? "pill is-active" : "pill", "All", row);
          allPill.addEventListener("click", function () { self._setActiveAlbum("all"); });

          this.state.albums.forEach(function (a) {
            var p = self._text("span", self.state.activeAlbum === a.id ? "pill is-active" : "pill", a.name, row);
            p.addEventListener("click", function () { self._setActiveAlbum(a.id); });
          });

          if (!this.state.isOwner) return;

          if (this.state.creatingAlbum) {
            var form = this._el("span", "new-album-form", row);
            var input = this._el("input", "input", form);
            input.type = "text";
            input.placeholder = "Album name";
            this._dom.albumDraftInput = input;
            input.addEventListener("keydown", function (e) {
              if (e.key === "Enter") self._confirmNewAlbum(input.value);
              if (e.key === "Escape") self._cancelNewAlbum();
            });
            var okBtn = this._text("button", "btn btn-primary btn-icon", "✓", form);
            okBtn.addEventListener("click", function () { self._confirmNewAlbum(input.value); });
            var cancelBtn = this._text("button", "btn btn-ghost", "✕", form);
            cancelBtn.addEventListener("click", function () { self._cancelNewAlbum(); });
          } else {
            var newBtn = this._text("span", "pill", "+ New Album", row);
            newBtn.addEventListener("click", function () { self._startNewAlbum(); });
          }
        },

        _renderGrid: function () {
          var self = this;
          var list = this._visiblePhotos();

          this._dom.gate.style.display = this.state.loaded ? "none" : "";
          this._dom.empty.style.display = this.state.loaded && list.length === 0 ? "" : "none";
          this._dom.grid.style.display = this.state.loaded && list.length > 0 ? "" : "none";

          this._clear(this._dom.grid);
          list.forEach(function (photo) {
            self._dom.grid.appendChild(self._buildTile(photo));
          });
        },

        _buildTile: function (photo) {
          var self = this;
          var tile = this._el("div", "gal-tile", null);
          tile.addEventListener("click", function () {
            if (self.state.reorderMode) return;
            self._openLightbox(photo.id);
          });

          var img = this._el("img", null, tile);
          img.alt = photo.caption || photo.name || "";
          // Otherwise the <img> is the native drag source, not the tile.
          img.draggable = false;
          lively.identity.fileCrypto.folderFileUrl(this.galleryHandle, this.galleryFolderObjId, photo, function (err, url) {
            if (!err) img.src = url;
          });

          if (photo.caption) {
            var cap = this._el("div", "gal-cap", tile);
            this._text("span", null, photo.caption, cap);
          }

          if (this.state.isOwner && this.state.reorderMode) {
            tile.draggable = true;
            tile.addEventListener("dragstart", function (e) { tile.classList.add("is-dragging"); self._onTileDragStart(photo.id, e); });
            tile.setAttribute("data-photo-id", photo.id);
            tile.addEventListener("dragend", function () { tile.classList.remove("is-dragging"); self.state.dragId = null; });
            var grip = this._el("div", "gal-grip", tile);
            this._svgIcon(ICON_GRIP, grip);
          }

          return tile;
        },

        _renderLightbox: function () {
          var self = this;
          var id = this.state.lightboxId;
          this._dom.lightboxBackdrop.style.display = id ? "" : "none";
          if (!id) return;

          var list = this._visiblePhotos();
          var idx = list.findIndex(function (p) { return p.id === id; });
          var photo = list[idx];
          if (!photo) { this.state.lightboxId = null; this._dom.lightboxBackdrop.style.display = "none"; return; }

          lively.identity.fileCrypto.folderFileUrl(this.galleryHandle, this.galleryFolderObjId, photo, function (err, url) {
            if (!err) self._dom.lightboxImg.src = url;
          });

          this._dom.lightboxCaption.value = this.state.draftCaption;
          this._dom.lightboxCaption.style.display = this.state.isOwner ? "" : "none";
          if (!this.state.isOwner && photo.caption) {
            this._dom.lightboxCaption.style.display = "none";
          }

          this._clear(this._dom.lightboxAlbums);
          if (this.state.isOwner) {
            var nonePill = this._text("span", !photo.albumId ? "pill is-active" : "pill", "No album", this._dom.lightboxAlbums);
            nonePill.addEventListener("click", function () { self._assignToAlbum(null); });
            this.state.albums.forEach(function (a) {
              var p = self._text("span", photo.albumId === a.id ? "pill is-active" : "pill", a.name, self._dom.lightboxAlbums);
              p.addEventListener("click", function () { self._assignToAlbum(a.id); });
            });
          }

          this._dom.lightboxDeleteBtn.style.display = this.state.isOwner ? "" : "none";
          this._dom.lightboxPosLabel.textContent = (idx + 1) + " / " + list.length;
        },
      },
    );

    GalleryClass.open = function (optPos) {
      var m = new lively.gallery.Gallery(lively.rect(0, 0, 1180, 780));
      m.setName("Gallery");
      m.openInWorld(optPos || lively.morphic.World.current().visibleBounds().center().subPt(lively.pt(590, 390)));
      // _setup() (and the _fitToWorld()/_buildHeader() it runs) fires via
      // prepareForNewRenderContext as part of openInWorld()'s own addMorph
      // step, before this morph is actually linked into the world's owner
      // chain — confirmed live: this.world() returns null at that point,
      // so the first-pass title falls back to "Gallery" and openInWorld's
      // own explicit `optPos` re-centering (which runs after _setup, inside
      // the same call) clobbers the fit-to-world position _fitToWorld just
      // set, even though it leaves the extent it set alone. Re-running both
      // now, with the morph genuinely attached, settles both for real.
      m._fitToWorld();
      m._renderHeader();
      return m;
    };
  }); // end module('lively.gallery.Gallery')
