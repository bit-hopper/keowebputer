/**
 * lively.books.Books
 *
 * A Goodreads-style personal book tracker: the third "world template" (see
 * core/lively/identity/WorldTemplateLauncher.js), following
 * lively.gallery.Gallery's architecture (itself following
 * lively.commerce.Shop's) exactly — self-rendering morph, raw DOM owned
 * directly, _buildChrome()/_render* idiom. Ported from a Claude Design
 * canvas mock ("Books Template" artifact, not real code — see
 * books-template.md at the repo root for the full design-decision log,
 * including the cascade-visibility algorithm this file ports verbatim)
 * into a working morph.
 *
 * Storage (books-template.md Research Finding #2):
 *   - One "Library" FileCrypto folder per owner (booksLibraryObjId/
 *     booksLibraryHandle, serialized Morph properties, same pattern as
 *     Gallery's galleryFolderObjId/galleryHandle), always visibility:
 *     'public' — reusing a FileCrypto folder's pointer-entry mechanism
 *     (addPointerToFolder) to index BOTH kinds of children a library has:
 *     pointer entries with refType:'book' (-> a standalone Book envelope,
 *     see below) and refType:'list' (-> a List, which is itself just
 *     ANOTHER FileCrypto folder, this one carrying the user's real
 *     Private/Shared/Public visibility choice). This needed zero new
 *     FileCrypto storage mechanisms beyond what Gallery/Lists already
 *     proved live — addPointerToFolder's refType was already
 *     caller-chosen, never hardcoded to 'book'.
 *   - A Book is its own small, always-public (plaintext) envelope
 *     (type:'book', FileCrypto.js's createBook/fetchBook/updateBook/
 *     deleteBook) — never a KEK/dek ceremony, since title/author/shelf/
 *     rating are meant to be visible on the owner's public shelf the same
 *     way a public Inventory listing is, and prompting a passkey touch on
 *     every single "add a book"/"rate a book" action would be bad UX for
 *     a lightweight, frequent-interaction tracker.
 *   - Reviews & Notes are NOT stored in the Book envelope at all — they
 *     reuse the existing generic `/@:handle/:objId/comments` REST routes
 *     (IdentityServer.js, originally built for Inventory items), keyed by
 *     the book's own objId. Any signed-in visitor can post one (matching
 *     the approved mockup's seed data, which shows other people's
 *     comments on a book, not just the owner's own notes) — this needed
 *     zero server changes to reuse.
 *
 * Privacy model (books-template.md's locked design decisions):
 *   - A book's title/author/shelf/rating/cover are ALWAYS visible to any
 *     visitor who can see the owner's Books world at all — confirmed by
 *     re-reading the approved mockup's own renderVals(): the book grid
 *     (`cards`) is built from ALL books with no isPublic filtering
 *     anywhere. Only the Reviews & Notes SECTION is gated.
 *   - Each book carries a plain-data `isPublic` boolean (Public/Private,
 *     default Public) that is purely a display preference, not real
 *     encryption — the same non-cryptographic-privacy precedent already
 *     established by Inventory's own 'public' item listings elsewhere in
 *     this codebase. See FileCrypto.js's 'book' category comment for the
 *     full reasoning.
 *   - Lists are real FileCrypto folders with REAL Private/Shared/Public
 *     crypto-backed visibility + real recipient sharing. A book's
 *     EFFECTIVE Reviews & Notes visibility is the most restrictive of (a)
 *     its own isPublic toggle and (b) every non-public list it belongs
 *     to — ranked Private(0) < Shared(1) < Public(2), effectiveRank =
 *     min(ownRank, every restricting list's rank) — ported verbatim from
 *     the mockup's renderVals() into _effectiveVisibility() below.
 *
 * Entry point:
 *   lively.books.Books.open(optWorldPosition)
 */

module("lively.books.Books")
  .requires()
  .toRun(function () {
    var ICON_CLOSE =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="5" x2="19" y2="19"></line><line x1="19" y1="5" x2="5" y2="19"></line></svg>';
    var ICON_TRASH =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>';
    var ICON_LOCK =
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>';
    var ICON_GLOBE =
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="3" y1="12" x2="21" y2="12"></line><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"></path></svg>';

    var SHELF_KEYS = ["want", "reading", "read", "dnf"];
    var SHELF_LABELS = { all: "All Books", want: "Want to Read", reading: "Reading", read: "Read", dnf: "Did Not Finish" };
    var VIS_RANK = { private: 0, shared: 1, public: 2 };
    var VIS_LABEL = { private: "Private", shared: "Shared", public: "Public" };
    var COVER_PALETTE = ["#2d3a56", "#5b3a5c", "#7a2e2e", "#b8862e", "#2f6b66", "#3f5d4e"];

    // Theme tokens ported verbatim from the approved mockup's THEMES object
    // (books-template.md's artifact iteration log) — reuse the exact
    // hex/font values, not an approximation.
    var THEMES = {
      walnut: {
        label: "Walnut",
        accent: "#7a2e2e", accent2: "#8b5e3c",
        bg: "#f6f1e7", sidebarBg: "#efe6d4", surface: "#fffaf0", surfaceAlt: "#f1e9d8", border: "#e3d9c6",
        text: "#2b2420", textMuted: "#6b5f52", textFaint: "#8a7c68", textSoft: "#5a4f42", textBody: "#45392f",
        fontDisplay: "'Playfair Display', serif", fontRead: "'Spectral', serif", fontUi: "'Inter', sans-serif",
        fontImport: "family=Playfair+Display:wght@700&family=Spectral:wght@400;600&family=Inter:wght@400;500;600;700",
      },
      echo: {
        label: "Echo",
        accent: "#e8497e", accent2: "#7cb342",
        bg: "#fdf0f5", sidebarBg: "#fbe0ec", surface: "#fff6fa", surfaceAlt: "#fbe0ec", border: "#f6cfe0",
        text: "#201e1d", textMuted: "#6b5560", textFaint: "#8a7680", textSoft: "#4a3f44", textBody: "#3a3034",
        fontDisplay: "'Caprasimo', serif", fontRead: "'Figtree', sans-serif", fontUi: "'Figtree', sans-serif",
        fontImport: "family=Caprasimo:wght@400&family=Figtree:wght@400;500;600;700",
      },
      ivory: {
        label: "Ivory",
        accent: "#b7824a", accent2: "#6f8f72",
        bg: "#faf8f3", sidebarBg: "#f3efe6", surface: "#ffffff", surfaceAlt: "#f5f1e8", border: "#e8e1d2",
        text: "#2e2a24", textMuted: "#6e6658", textFaint: "#938a78", textSoft: "#4c4638", textBody: "#3c3730",
        fontDisplay: "'Fraunces', serif", fontRead: "'Fraunces', serif", fontUi: "'Inter', sans-serif",
        fontImport: "family=Fraunces:wght@400;600;700&family=Inter:wght@400;500;600;700",
      },
    };
    var THEME_KEYS = ["walnut", "echo", "ivory"];

    function themeCssBlock(key) {
      var t = THEMES[key];
      return (
        '.lk-books-viewport[data-theme="' + key + '"] {' +
        " --b-accent:" + t.accent + "; --b-accent2:" + t.accent2 + ";" +
        " --b-bg:" + t.bg + "; --b-sidebar-bg:" + t.sidebarBg + "; --b-surface:" + t.surface + ";" +
        " --b-surface-alt:" + t.surfaceAlt + "; --b-border:" + t.border + ";" +
        " --b-text:" + t.text + "; --b-text-muted:" + t.textMuted + "; --b-text-faint:" + t.textFaint + ";" +
        " --b-text-soft:" + t.textSoft + "; --b-text-body:" + t.textBody + ";" +
        " --b-font-display:" + t.fontDisplay + "; --b-font-read:" + t.fontRead + "; --b-font-ui:" + t.fontUi + ";" +
        " }"
      );
    }

    // Every rule scoped under .lk-books-root/.lk-books-viewport so this
    // can't leak into the rest of the Lively world (Shop.js/Gallery.js's
    // own idiom). Theme custom properties live on .lk-books-viewport (the
    // OUTER node), not .lk-books-root, because both modals are siblings of
    // .lk-books-root (not descendants) under the two-wrapper scroll split
    // below — scoping the vars to .lk-books-root alone would leave the
    // modals unthemed (same reasoning Gallery.js's own CSS already follows
    // for its lightbox).
    var BOOKS_CSS = "" +
      "@import url('https://fonts.googleapis.com/css2?" +
      THEME_KEYS.map(function (k) { return THEMES[k].fontImport; }).join("&") +
      "&display=swap');" +
      THEME_KEYS.map(themeCssBlock).join("") +
      ".lk-books-viewport {" +
      "  background:var(--b-bg); color:var(--b-text); font-family:var(--b-font-ui);" +
      "  font-size:14px; line-height:1.5; height:100%; position:relative; overflow:hidden; box-sizing:border-box;" +
      "  transition:background 0.2s ease, color 0.2s ease;" +
      "}" +
      ".lk-books-root { height:100%; overflow-y:auto; position:relative; scrollbar-width:thin; scrollbar-color:var(--b-accent) var(--b-surface-alt); }" +
      ".lk-books-root::-webkit-scrollbar { width:10px; }" +
      ".lk-books-root::-webkit-scrollbar-track { background:var(--b-surface-alt); }" +
      ".lk-books-root::-webkit-scrollbar-thumb { background:var(--b-accent); border-radius:999px; border:2px solid var(--b-surface-alt); }" +
      ".lk-books-viewport, .lk-books-viewport *, .lk-books-viewport *::before, .lk-books-viewport *::after { box-sizing:border-box; }" +
      ".lk-books-viewport h1, .lk-books-viewport h2, .lk-books-viewport h3 { font-family:var(--b-font-display); font-weight:700; margin:0; }" +
      ".lk-books-viewport .text-muted { color:var(--b-text-muted) } .lk-books-viewport .text-faint { color:var(--b-text-faint) }" +
      ".lk-books-viewport .btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; cursor:pointer;" +
      "  font-family:var(--b-font-ui); font-weight:600; font-size:13px; color:var(--b-text); background:transparent;" +
      "  border:1px solid transparent; padding:8px 16px; border-radius:999px; white-space:nowrap;}" +
      ".lk-books-viewport .btn:disabled { opacity:0.45; cursor:not-allowed }" +
      ".lk-books-viewport .btn-primary { background:var(--b-accent); color:#fdf8ec }" +
      ".lk-books-viewport .btn-primary:hover { filter:brightness(0.94) }" +
      ".lk-books-viewport .btn-outline { border-color:var(--b-accent); background:transparent; color:var(--b-accent) }" +
      ".lk-books-viewport .btn-outline.is-active { background:var(--b-accent); color:#fdf8ec }" +
      ".lk-books-viewport .btn-ghost { color:var(--b-text-faint); border:none; background:transparent; padding:3px 6px; font-size:20px; line-height:1; }" +
      ".lk-books-viewport .btn-ghost:hover { color:var(--b-text) }" +
      ".lk-books-viewport .pill { display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 13px; border-radius:999px; font-size:11px; font-weight:600; cursor:pointer; border:1px solid var(--b-border); background:var(--b-surface); }" +
      ".lk-books-viewport .input { width:100%; min-height:32px; padding:7px 12px; font:inherit; font-size:13px; color:var(--b-text);" +
      "  background:var(--b-surface); border:1px solid var(--b-border); border-radius:8px;}" +
      ".lk-books-viewport .input:focus-visible { outline:2px solid var(--b-accent); outline-offset:0 }" +
      // header
      ".lk-books-viewport .hdr { background:var(--b-accent); color:#fdf8ec; padding:18px 30px; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:16px; }" +
      ".lk-books-viewport .hdr-title { font-family:var(--b-font-display); font-size:24px; font-weight:700; line-height:1; }" +
      ".lk-books-viewport .hdr-sub { font-size:12px; opacity:0.75; margin-top:3px; }" +
      ".lk-books-viewport .hdr-right { display:flex; align-items:center; gap:16px; }" +
      ".lk-books-viewport .swatch-row { display:flex; gap:7px; align-items:center; }" +
      ".lk-books-viewport .swatch { width:20px; height:20px; border-radius:50%; cursor:pointer; padding:0; border:2px solid rgba(255,255,255,0.35); }" +
      ".lk-books-viewport .swatch.is-active { border-color:#fdf8ec }" +
      ".lk-books-viewport .hdr-addbtn { background:#fdf8ec; color:var(--b-accent); border:none; border-radius:999px; padding:10px 20px; font-weight:600; font-size:13px; cursor:pointer; }" +
      ".lk-books-viewport .hdr-strip { height:7px; background:var(--b-accent2); }" +
      // layout
      ".lk-books-viewport .body-row { display:flex; flex-wrap:wrap; min-height:calc(100% - 65px); }" +
      ".lk-books-viewport .sidebar { flex:1 1 220px; max-width:238px; background:var(--b-sidebar-bg); padding:22px 14px; box-sizing:border-box; }" +
      ".lk-books-viewport .side-section { margin-bottom:24px; }" +
      ".lk-books-viewport .side-label { font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--b-text-faint); padding:0 10px; margin-bottom:7px; display:flex; justify-content:space-between; align-items:center; }" +
      ".lk-books-viewport .side-item { display:flex; justify-content:space-between; align-items:center; gap:6px; width:100%; text-align:left; padding:8px 10px; border-radius:8px; border:none; background:transparent; color:var(--b-text-soft); font-size:12.5px; font-weight:500; cursor:pointer; margin-bottom:2px; }" +
      ".lk-books-viewport .side-item.is-active { background:var(--b-surface); color:var(--b-accent); font-weight:700; }" +
      ".lk-books-viewport .side-item .count { opacity:0.6; flex-shrink:0; }" +
      ".lk-books-viewport .side-item .side-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }" +
      ".lk-books-viewport .vis-badge { font-size:9.5px; font-weight:700; padding:2px 7px; border-radius:999px; flex-shrink:0; }" +
      ".lk-books-viewport .vis-badge.private { background:#f1e9d8; color:#8a7c68; }" +
      ".lk-books-viewport .vis-badge.shared { background:#e6edf5; color:#3a5a80; }" +
      ".lk-books-viewport .vis-badge.public { background:#e7efe6; color:#3f5d4e; }" +
      ".lk-books-viewport .side-newbtn { background:none; border:none; color:var(--b-accent); font-size:16px; font-weight:700; cursor:pointer; line-height:1; padding:0 2px; }" +
      ".lk-books-viewport .newlist-form { margin-top:6px; padding:11px; background:var(--b-surface); border-radius:10px; display:flex; flex-direction:column; gap:7px; }" +
      ".lk-books-viewport .newlist-vis-row { display:flex; gap:5px; }" +
      ".lk-books-viewport .newlist-vis-row .btn-outline { flex:1; font-size:10.5px; padding:5px 3px; }" +
      ".lk-books-viewport .share-chip { display:inline-flex; align-items:center; gap:4px; font-size:11px; background:#e6edf5; color:#3a5a80; padding:3px 8px; border-radius:999px; }" +
      ".lk-books-viewport .share-chip button { background:none; border:none; color:#3a5a80; font-size:12px; cursor:pointer; padding:0; line-height:1; }" +
      ".lk-books-viewport .chip-row { display:flex; gap:6px; flex-wrap:wrap; }" +
      // main
      ".lk-books-viewport .main { flex:999 1 560px; min-width:0; padding:26px 34px 70px; box-sizing:border-box; }" +
      ".lk-books-viewport .main-hdr { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; gap:12px; flex-wrap:wrap; }" +
      ".lk-books-viewport .main-title { font-size:21px; font-weight:700; font-family:var(--b-font-display); }" +
      ".lk-books-viewport .main-count { font-size:12px; color:var(--b-text-faint); margin-top:2px; }" +
      ".lk-books-viewport .share-row { display:flex; align-items:center; gap:9px; flex-wrap:wrap; margin-bottom:20px; }" +
      ".lk-books-viewport .share-row .input { width:130px; }" +
      ".lk-books-viewport .gate, .empty { padding:70px 20px; text-align:center; color:var(--b-text-faint); }" +
      ".lk-books-viewport .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(148px, 1fr)); gap:24px; }" +
      ".lk-books-viewport .book-tile { text-align:left; background:none; border:none; padding:0; cursor:pointer; display:flex; flex-direction:column; gap:8px; }" +
      ".lk-books-viewport .book-cover { position:relative; aspect-ratio:2/3; border-radius:6px; box-shadow:-6px 0 0 rgba(0,0,0,0.18) inset, 0 10px 20px rgba(43,36,32,0.18); display:flex; align-items:center; justify-content:center; padding:14px; overflow:hidden; background-size:cover; background-position:center; }" +
      ".lk-books-viewport .book-cover-text { position:relative; text-align:center; color:#fdf8ec; font-family:var(--b-font-display); font-weight:700; font-size:14px; line-height:1.25; text-shadow:0 1px 3px rgba(0,0,0,0.4); }" +
      ".lk-books-viewport .book-cover-author { font-family:var(--b-font-read); font-size:10.5px; margin-top:7px; opacity:0.85; font-weight:400; }" +
      ".lk-books-viewport .shelf-badge { position:absolute; top:6px; right:6px; background:rgba(0,0,0,0.4); color:#fdf8ec; font-size:9.5px; padding:3px 7px; border-radius:999px; }" +
      ".lk-books-viewport .book-title { font-size:12.5px; font-weight:600; }" +
      ".lk-books-viewport .book-author { font-size:11.5px; color:var(--b-text-muted); }" +
      ".lk-books-viewport .book-stars { font-size:12.5px; color:#c99a3e; margin-top:1px; }" +
      // modals (siblings of .lk-books-root)
      ".lk-books-viewport .dialog-backdrop { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; padding:24px;" +
      "  background:rgba(43,36,32,0.55); z-index:30; box-sizing:border-box; }" +
      ".lk-books-viewport .detail-box { background:var(--b-surface); border-radius:14px; max-width:860px; width:100%; max-height:88vh; overflow-y:auto; box-shadow:0 30px 60px rgba(0,0,0,0.35); display:flex; flex-wrap:wrap; }" +
      ".lk-books-viewport .detail-cover-pane { width:220px; flex:0 0 220px; padding:26px; display:flex; flex-direction:column; align-items:center; gap:14px; background:var(--b-surface-alt); box-sizing:border-box; }" +
      ".lk-books-viewport .detail-cover { width:100%; aspect-ratio:2/3; border-radius:8px; display:flex; align-items:center; justify-content:center; padding:18px; box-sizing:border-box; box-shadow:-8px 0 0 rgba(0,0,0,0.18) inset, 0 14px 26px rgba(43,36,32,0.22); background-size:cover; background-position:center; }" +
      ".lk-books-viewport .detail-cover-text { text-align:center; color:#fdf8ec; font-family:var(--b-font-display); font-weight:700; font-size:17px; line-height:1.25; text-shadow:0 1px 3px rgba(0,0,0,0.4); }" +
      ".lk-books-viewport .detail-cover-author { font-family:var(--b-font-read); font-size:11px; margin-top:9px; opacity:0.85; }" +
      ".lk-books-viewport .shelf-pill-row { display:flex; gap:5px; flex-wrap:wrap; justify-content:center; }" +
      ".lk-books-viewport .shelf-pill-row .btn-outline { font-size:10.5px; padding:5px 9px; }" +
      ".lk-books-viewport .detail-body { flex:1; min-width:300px; padding:26px; box-sizing:border-box; }" +
      ".lk-books-viewport .detail-top { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }" +
      ".lk-books-viewport .detail-title { font-family:var(--b-font-display); font-size:23px; font-weight:700; }" +
      ".lk-books-viewport .detail-author { font-family:var(--b-font-read); font-size:14px; color:var(--b-text-muted); margin-top:3px; }" +
      ".lk-books-viewport .stars-row { display:flex; gap:2px; margin-top:12px; }" +
      ".lk-books-viewport .star-btn { font-size:20px; line-height:1; background:none; border:none; cursor:pointer; padding:0; color:#d8cdb8; }" +
      ".lk-books-viewport .star-btn.filled { color:#c99a3e; }" +
      ".lk-books-viewport .star-btn:disabled { cursor:default; }" +
      ".lk-books-viewport .detail-desc { font-family:var(--b-font-read); font-size:13.5px; line-height:1.6; color:var(--b-text-body); margin-top:14px; }" +
      ".lk-books-viewport .detail-section { margin-top:22px; }" +
      ".lk-books-viewport .detail-section-label { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; color:var(--b-text-muted); margin-bottom:7px; }" +
      ".lk-books-viewport .reviews-hdr { display:flex; align-items:center; justify-content:space-between; border-top:1px solid var(--b-border); padding-top:16px; }" +
      ".lk-books-viewport .privacy-pill { font-size:10.5px; font-weight:600; padding:5px 11px; border-radius:999px; border:1px solid var(--b-border); cursor:pointer; }" +
      ".lk-books-viewport .privacy-note { font-size:10.5px; color:var(--b-text-faint); margin-top:4px; }" +
      ".lk-books-viewport .comment-row { display:flex; gap:9px; margin-top:13px; }" +
      ".lk-books-viewport .comment-avatar { width:28px; height:28px; border-radius:50%; background:var(--b-accent); color:#fdf8ec; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:12px; flex-shrink:0; }" +
      ".lk-books-viewport .comment-author { font-size:11.5px; font-weight:700; } .lk-books-viewport .comment-date { font-size:10.5px; color:var(--b-text-faint); margin-left:7px; }" +
      ".lk-books-viewport .comment-text { font-family:var(--b-font-read); font-size:12.5px; color:var(--b-text-body); margin-top:2px; }" +
      ".lk-books-viewport .comment-form { margin-top:14px; display:flex; gap:9px; }" +
      ".lk-books-viewport .delete-row { margin-top:22px; text-align:right; }" +
      // add-a-book modal
      ".lk-books-viewport .add-box { background:var(--b-surface); border-radius:14px; max-width:560px; width:100%; max-height:80vh; overflow-y:auto; padding:26px; box-sizing:border-box; }" +
      ".lk-books-viewport .add-hdr { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }" +
      ".lk-books-viewport .add-title { font-family:var(--b-font-display); font-size:21px; font-weight:700; }" +
      ".lk-books-viewport .add-hint { font-size:10.5px; color:var(--b-text-faint); margin:6px 0 14px; }" +
      ".lk-books-viewport .add-result { display:flex; gap:11px; align-items:center; padding:9px; border:1px solid var(--b-border); border-radius:10px; margin-bottom:9px; }" +
      ".lk-books-viewport .add-result-cover { width:36px; height:52px; border-radius:4px; flex-shrink:0; background-size:cover; background-position:center; }" +
      ".lk-books-viewport .add-result-title { font-size:12.5px; font-weight:600; } .lk-books-viewport .add-result-author { font-size:11.5px; color:var(--b-text-muted); }" +
      ".lk-books-viewport .add-result-src { font-size:9.5px; color:var(--b-text-faint); margin-top:2px; }" +
      "";

    var BooksClass = lively.morphic.Box.subclass(
      "lively.books.Books",

      "serialization",
      {
        // state/_dom are rebuilt from scratch in _setup() on every fresh
        // render context; _identityConnection is a live Connection (Shop/
        // Gallery's exact doNotSerialize bug class). booksLibraryObjId/
        // booksLibraryHandle/booksTheme are deliberately real (serialized)
        // Morph properties — the only things this morph needs to remember
        // across a reload to find its own backing library folder again.
        doNotSerialize: ["state", "_dom", "_identityConnection", "_didHandleMap", "_libraryEnsurePending"],
      },

      "initialization",
      {
        DEFAULT_EXTENT: { w: 1280, h: 820 },

        initialize: function ($super, optExtent) {
          $super(optExtent || lively.rect(0, 0, 1280, 820));
          this.setFill(null);
          this.setBorderWidth(0);
          // Same reasoning as Gallery.js's own initialize(): a plain Box
          // defaults to draggable/droppable/grabbable, and this morph is a
          // full-viewport app template with everything living as plain DOM
          // inside its own single shapeNode (not separate submorphs), so
          // there's only this one set of flags to clear.
          this.disableDragging();
          this.disableDropping();
          this.disableGrabbing();
        },

        _setup: function () {
          this._dom = {};
          this.state = {
            theme: this.booksTheme || "echo",
            isOwner: false,
            loaded: false,
            books: [],
            lists: [],
            filterType: "shelf",
            filterKey: "all",
            detailObjId: null,
            comments: [],
            commentsLoading: false,
            commentDraft: "",
            addOpen: false,
            addQuery: "",
            addResults: [],
            addSearching: false,
            newListOpen: false,
            newListName: "",
            newListVisibility: "public",
            newListShareHandles: [],
            newListShareDraft: "",
            shareDraft: "",
          };
          this._didHandleMap = this._didHandleMap || {};
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
          $super();
        },
      },

      "layout",
      {
        // Same onWorldResize/_fitToWorld idiom as Gallery.js — see that
        // file's own comment for the full reasoning (MobileInterface.js/
        // MenuBar.js precedent).
        _fitToWorld: function () {
          if (typeof $world === "undefined" || !$world) return;
          var vb = $world.visibleBounds();
          this.setPosition(vb.topLeft());
          this.setExtent(vb.extent());
        },
        onWorldResize: function () {
          lively.lang.fun.debounceNamed(this.id + "-books-world-resize", 150, this._fitToWorld.bind(this))();
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
        // Same gotcha/fix as Gallery.js's _worldName — $world.name is NOT
        // kept in sync with the real assigned display name; the actual
        // source of truth is document.title (IdentityServer.js's
        // buildWorldPage sets it server-side from envelope.state.name).
        _worldName: function () {
          var t = document.title;
          var isDefault = !t || t === "world" || t === "Lively" || t === "untitled world";
          return isDefault ? "My Library" : t;
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
          this.state.isOwner = !!(user && this.booksLibraryHandle && user.handle === this.booksLibraryHandle);
          this._renderAll();
        },
      },

      "chrome building",
      {
        _buildChrome: function () {
          if (!document.getElementById("books-styles")) {
            var styleTag = document.createElement("style");
            styleTag.id = "books-styles";
            styleTag.textContent = BOOKS_CSS;
            document.head.appendChild(styleTag);
          }

          var shapeNode = this.renderContext().shapeNode;
          shapeNode.innerHTML = "";
          shapeNode.style.overflow = "hidden";

          var viewport = this._el("div", "lk-books-viewport", shapeNode);
          viewport.dataset.theme = this.state.theme;
          this._dom.viewport = viewport;
          var root = this._el("div", "lk-books-root", viewport);
          this._dom.root = root;

          this._buildHeader(root);
          var bodyRow = this._el("div", "body-row", root);
          this._buildSidebar(bodyRow);
          this._buildMain(bodyRow);

          this._buildDetailModal(viewport);
          this._buildAddModal(viewport);
        },

        _buildHeader: function (root) {
          var self = this;
          var hdr = this._el("div", "hdr", root);

          var left = this._el("div", null, hdr);
          this._dom.titleEl = this._text("div", "hdr-title", this._worldName(), left);
          this._dom.subEl = this._text("div", "hdr-sub", "", left);

          var right = this._el("div", "hdr-right", hdr);
          var swatchRow = this._el("div", "swatch-row", right);
          this._dom.swatches = {};
          THEME_KEYS.forEach(function (key) {
            var t = THEMES[key];
            var sw = self._el("button", "swatch", swatchRow);
            sw.title = t.label;
            sw.setAttribute("aria-label", t.label + " theme");
            sw.style.background = t.accent;
            sw.addEventListener("click", function () { self._setTheme(key); });
            self._dom.swatches[key] = sw;
          });

          this._dom.addBookBtn = this._text("button", "hdr-addbtn", "+ Add a Book", right);
          this._dom.addBookBtn.addEventListener("click", function () { self._openAddModal(); });

          this._el("div", "hdr-strip", root);
        },

        _buildSidebar: function (bodyRow) {
          var self = this;
          var sidebar = this._el("div", "sidebar", bodyRow);

          var shelfSection = this._el("div", "side-section", sidebar);
          this._text("div", "side-label", "Shelves", shelfSection);
          this._dom.shelfRow = this._el("div", null, shelfSection);

          var listSection = this._el("div", "side-section", sidebar);
          var listLabelRow = this._el("div", "side-label", listSection);
          listLabelRow.appendChild(document.createTextNode("Lists"));
          this._dom.newListBtn = this._text("button", "side-newbtn", "+", listLabelRow);
          this._dom.newListBtn.setAttribute("aria-label", "New list");
          this._dom.newListBtn.addEventListener("click", function () { self._startNewList(); });

          this._dom.listRow = this._el("div", null, listSection);
          this._dom.newListFormWrap = this._el("div", null, listSection);
        },

        _buildMain: function (bodyRow) {
          var main = this._el("div", "main", bodyRow);
          this._dom.main = main;

          var mainHdr = this._el("div", "main-hdr", main);
          var titleCol = this._el("div", null, mainHdr);
          this._dom.selectionTitle = this._text("div", "main-title", "", titleCol);
          this._dom.selectionCount = this._text("div", "main-count", "", titleCol);
          this._dom.listPrivacyBtn = this._text("button", "privacy-pill", "", mainHdr);
          this._dom.listPrivacyBtn.style.display = "none";
          this._dom.listPrivacyBtn.addEventListener("click", this._toggleActiveListVisibility.bind(this));

          this._dom.shareRow = this._el("div", "share-row", main);
          this._dom.shareRow.style.display = "none";

          this._dom.gate = this._el("div", "gate", main);
          this._text("p", null, "Loading your library…", this._dom.gate);
          this._dom.empty = this._el("div", "empty", main);
          this._dom.empty.style.display = "none";
          this._text("h3", null, "No books here yet", this._dom.empty);
          this._text("p", "text-muted", "Add a book to get started.", this._dom.empty);
          var grid = this._el("div", "grid", main);
          grid.style.display = "none";
          this._dom.grid = grid;
        },

        _buildDetailModal: function (viewport) {
          var self = this;
          var backdrop = this._el("div", "dialog-backdrop", viewport);
          backdrop.style.display = "none";
          backdrop.addEventListener("mousedown", function (e) { if (e.target === backdrop) self._closeBook(); });
          this._dom.detailBackdrop = backdrop;

          var box = this._el("div", "detail-box", backdrop);
          box.addEventListener("mousedown", function (e) { e.stopPropagation(); });

          var coverPane = this._el("div", "detail-cover-pane", box);
          this._dom.detailCover = this._el("div", "detail-cover", coverPane);
          this._dom.detailCoverText = this._el("div", "detail-cover-text", this._dom.detailCover);
          this._dom.detailCoverAuthor = this._el("div", "detail-cover-author", this._dom.detailCoverText);
          this._dom.shelfPillRow = this._el("div", "shelf-pill-row", coverPane);

          var body = this._el("div", "detail-body", box);
          var top = this._el("div", "detail-top", body);
          var titleCol = this._el("div", null, top);
          this._dom.detailTitle = this._text("div", "detail-title", "", titleCol);
          this._dom.detailAuthor = this._text("div", "detail-author", "", titleCol);
          var closeBtn = this._text("button", "btn-ghost", "", top);
          this._svgIcon(ICON_CLOSE, closeBtn);
          closeBtn.setAttribute("aria-label", "Close");
          closeBtn.addEventListener("click", function () { self._closeBook(); });

          this._dom.starsRow = this._el("div", "stars-row", body);
          this._dom.detailDesc = this._el("p", "detail-desc", body);

          var listsSection = this._el("div", "detail-section", body);
          this._text("div", "detail-section-label", "Lists", listsSection);
          this._dom.listChipRow = this._el("div", "chip-row", listsSection);

          var reviewsSection = this._el("div", "detail-section", body);
          var reviewsHdr = this._el("div", "reviews-hdr", reviewsSection);
          this._text("div", "detail-section-label", "Reviews & Notes", reviewsHdr);
          this._dom.detailPrivacyBtn = this._text("button", "privacy-pill", "", reviewsHdr);
          this._dom.detailPrivacyBtn.addEventListener("click", function () { self._toggleBookPrivacy(); });
          this._dom.privacyNote = this._text("div", "privacy-note", "", reviewsSection);
          this._dom.commentList = this._el("div", null, reviewsSection);

          this._dom.commentForm = this._el("div", "comment-form", reviewsSection);
          var commentInput = this._el("input", "input", this._dom.commentForm);
          commentInput.type = "text";
          commentInput.placeholder = "Add a note or review…";
          commentInput.addEventListener("input", function () { self.state.commentDraft = commentInput.value; });
          commentInput.addEventListener("keydown", function (e) { if (e.key === "Enter") self._postComment(); });
          this._dom.commentInput = commentInput;
          var postBtn = this._text("button", "btn btn-primary", "Post", this._dom.commentForm);
          postBtn.addEventListener("click", function () { self._postComment(); });

          var deleteRow = this._el("div", "delete-row", body);
          this._dom.deleteBtn = this._text("button", "btn btn-ghost", "", deleteRow);
          this._dom.deleteBtn.style.fontSize = "13px";
          this._svgIcon(ICON_TRASH, this._dom.deleteBtn);
          this._dom.deleteBtn.appendChild(document.createTextNode(" Delete book"));
          this._dom.deleteBtn.addEventListener("click", function () { self._deleteCurrentBook(); });
        },

        _buildAddModal: function (viewport) {
          var self = this;
          var backdrop = this._el("div", "dialog-backdrop", viewport);
          backdrop.style.display = "none";
          backdrop.style.zIndex = "40";
          backdrop.addEventListener("mousedown", function (e) { if (e.target === backdrop) self._closeAddModal(); });
          this._dom.addBackdrop = backdrop;

          var box = this._el("div", "add-box", backdrop);
          box.addEventListener("mousedown", function (e) { e.stopPropagation(); });

          var hdr = this._el("div", "add-hdr", box);
          this._text("div", "add-title", "Add a Book", hdr);
          var closeBtn = this._text("button", "btn-ghost", "", hdr);
          this._svgIcon(ICON_CLOSE, closeBtn);
          closeBtn.addEventListener("click", function () { self._closeAddModal(); });

          var queryInput = this._el("input", "input", box);
          queryInput.type = "text";
          queryInput.placeholder = "Search by title or author…";
          queryInput.addEventListener("input", function () { self._onAddQueryInput(queryInput.value); });
          this._dom.addQueryInput = queryInput;

          this._dom.addHint = this._text("div", "add-hint", "Searching Google Books and Open Library…", box);
          this._dom.addResultsEl = this._el("div", null, box);
        },
      },

      "theme",
      {
        _setTheme: function (key) {
          this.state.theme = key;
          this.booksTheme = key;
          this._dom.viewport.dataset.theme = key;
          this._renderSwatches();
        },
      },

      "storage: library",
      {
        _ensureLibrary: function () {
          var self = this;
          var user = this._currentUser();

          if (this.booksLibraryObjId && this.booksLibraryHandle) return this._loadLibrary();
          if (!user) return; // wait for _onIdentityChanged to retry
          // Without this guard, _setup()'s own direct call and
          // _onIdentityChanged() (fired separately by restoreSession's async
          // resolve, per _bindIdentity's comment) can both see
          // booksLibraryObjId still unset and both call createFolder --
          // confirmed live 2026-10-05 driving the real WorldsBrowser ->
          // submitCreate -> redirect -> page-load flow (not just a direct
          // .open() call): two "Library" folders were created, the second
          // call's createFolder resolving after the first and silently
          // overwriting booksLibraryObjId/triggering a second
          // _saveCurrentWorld(), leaving the first folder a harmless but
          // avoidable orphan (no data loss -- the final saved state was
          // still self-consistent -- just wasted storage on every single
          // world creation). Gallery.js's _ensureFolder has this identical
          // latent race; not fixed there in this pass (out of scope here),
          // only guarded for Books.
          if (this._libraryEnsurePending) return;
          this._libraryEnsurePending = true;

          lively.identity.fileCrypto.createFolder("Library", { visibility: "public" }, function (err, result) {
            self._libraryEnsurePending = false;
            if (err) { console.warn("[Books] could not create library:", err.message); return; }
            self.booksLibraryObjId = result.objId;
            self.booksLibraryHandle = user.handle;
            self._loadLibrary();
            // Same race as Gallery.js's _ensureFolder: WorldTemplateLauncher's
            // own _saveCurrentWorld() (fired by its "shop" case right after
            // .open() returns) would run BEFORE this async createFolder
            // ceremony resolves, saving the morph with no
            // booksLibraryObjId/booksLibraryHandle set — so the "books" case
            // below deliberately doesn't call it, and this is the one
            // place that does, once the folder genuinely exists.
            if (typeof lively !== "undefined" && lively.identity && lively.identity.WorldTemplateLauncher && lively.identity.WorldTemplateLauncher._saveCurrentWorld) {
              lively.identity.WorldTemplateLauncher._saveCurrentWorld();
            }
          });
        },

        _loadLibrary: function () {
          var self = this;
          lively.identity.fileCrypto.fetchFolder(this.booksLibraryHandle, this.booksLibraryObjId, function (err, folder) {
            if (err) { console.warn("[Books] could not load library:", err.message); return; }
            self.state.isOwner = folder.isOwner;
            var bookPointers = folder.files.filter(function (f) { return f.refType === "book"; });
            var listPointers = folder.files.filter(function (f) { return f.refType === "list"; });

            self._loadBooks(bookPointers, function (books) {
              self.state.books = books;
              self._loadLists(listPointers, function (lists) {
                self.state.lists = lists;
                self.state.loaded = true;
                self._renderAll();
                self._resolveListHandles();
              });
            });
          });
        },

        _loadBooks: function (pointers, thenDo) {
          var self = this;
          if (!pointers.length) return thenDo([]);
          var out = [];
          var remaining = pointers.length;
          pointers.forEach(function (ptr) {
            lively.identity.fileCrypto.fetchBook(self.booksLibraryHandle, ptr.refObjId, function (err, result) {
              if (!err && result && result.book && !(result.envelope.state && result.envelope.state.deleted)) {
                out.push(Object.assign({ objId: result.objId, libraryPointerId: ptr.id }, result.book));
              }
              if (--remaining === 0) thenDo(out);
            });
          });
        },

        // A private/shared list this viewer has no sealed dek for fails to
        // fetchFolder here — skipped silently rather than erroring the
        // whole library, same fail-closed behavior a non-recipient visitor
        // should see (they simply never find out the list exists).
        _loadLists: function (pointers, thenDo) {
          var self = this;
          if (!pointers.length) return thenDo([]);
          var out = [];
          var remaining = pointers.length;
          pointers.forEach(function (ptr) {
            lively.identity.fileCrypto.fetchFolder(self.booksLibraryHandle, ptr.refObjId, function (err, folder) {
              if (!err && folder) {
                out.push({
                  objId: folder.objId,
                  libraryPointerId: ptr.id,
                  name: folder.name,
                  visibility: folder.envelope.visibility,
                  recipients: (folder.envelope.record.recipients || []).map(function (r) { return r.did; }),
                  bookEntries: folder.files.filter(function (f) { return f.refType === "book"; })
                    .map(function (f) { return { pointerId: f.id, bookObjId: f.refObjId }; }),
                });
              }
              if (--remaining === 0) thenDo(out);
            });
          });
        },

        _resolveListHandles: function () {
          var self = this;
          var dids = [];
          this.state.lists.forEach(function (l) {
            l.recipients.forEach(function (d) { if (dids.indexOf(d) === -1) dids.push(d); });
          });
          if (!dids.length) return;
          fetch("/dids/handles?dids=" + encodeURIComponent(dids.join(",")), { credentials: "include" })
            .then(function (r) { return r.ok ? r.json() : { handles: {} }; })
            .then(function (data) {
              self._didHandleMap = Object.assign(self._didHandleMap || {}, data.handles || {});
              self._renderSidebar();
              self._renderGrid();
            }).catch(function () {});
        },
      },

      "cascade visibility",
      {
        // Ported verbatim from the approved mockup's renderVals() (see
        // books-template.md's "Cascade rule" design decision) — a book's
        // effective Reviews & Notes visibility is the most restrictive of
        // its own isPublic toggle and every non-public list it belongs to.
        _effectiveVisibility: function (book) {
          var ownRank = book.isPublic ? VIS_RANK.public : VIS_RANK.private;
          var restricting = this.state.lists.filter(function (l) {
            return l.visibility !== "public" && l.bookEntries.some(function (e) { return e.bookObjId === book.objId; });
          });
          var locked = restricting.length > 0;
          var effectiveRank = ownRank;
          var bindingList = null;
          if (locked) {
            var ranks = [ownRank].concat(restricting.map(function (l) { return VIS_RANK[l.visibility]; }));
            effectiveRank = Math.min.apply(null, ranks);
            var atMin = restricting.filter(function (l) { return VIS_RANK[l.visibility] === effectiveRank; });
            bindingList = atMin[0] || restricting[0];
          }
          var visibility = effectiveRank === VIS_RANK.public ? "public" : (effectiveRank === VIS_RANK.shared ? "shared" : "private");
          return { visibility: visibility, locked: locked && effectiveRank < ownRank, bindingList: bindingList };
        },
      },

      "filtering",
      {
        _setFilter: function (type, key) {
          this.state.filterType = type;
          this.state.filterKey = key;
          this.state.shareDraft = "";
          this._renderSidebar();
          this._renderGrid();
        },
        _filteredBooks: function () {
          var self = this;
          if (this.state.filterType === "list") {
            var list = this.state.lists.filter(function (l) { return l.objId === self.state.filterKey; })[0];
            if (!list) return [];
            var ids = list.bookEntries.map(function (e) { return e.bookObjId; });
            return this.state.books.filter(function (b) { return ids.indexOf(b.objId) !== -1; });
          }
          var key = this.state.filterKey;
          if (key === "all") return this.state.books;
          return this.state.books.filter(function (b) { return b.shelf === key; });
        },
      },

      "covers",
      {
        _coverColorFor: function (title) {
          var hash = 0;
          (title || "").split("").forEach(function (ch) { hash = (hash * 31 + ch.charCodeAt(0)) | 0; });
          return COVER_PALETTE[Math.abs(hash) % COVER_PALETTE.length];
        },
        _cssUrl: function (url) {
          return "url('" + String(url).replace(/'/g, "%27") + "')";
        },
        _applyCover: function (el, textEl, book) {
          if (book.coverUrl) {
            el.style.backgroundImage = this._cssUrl(book.coverUrl);
            el.style.backgroundColor = "transparent";
            textEl.style.display = "none";
          } else {
            el.style.backgroundImage = "none";
            el.style.backgroundColor = this._coverColorFor(book.title);
            textEl.style.display = "";
          }
        },
      },

      "add a book",
      {
        _openAddModal: function () {
          this.state.addOpen = true;
          this.state.addQuery = "";
          this.state.addResults = [];
          this._dom.addQueryInput.value = "";
          this._renderAddModal();
        },
        _closeAddModal: function () {
          this.state.addOpen = false;
          this._renderAddModal();
        },
        _onAddQueryInput: function (value) {
          this.state.addQuery = value;
          var self = this;
          clearTimeout(this._addSearchTimer);
          var q = value.trim();
          if (!q) { this.state.addResults = []; this._renderAddResults(); return; }
          this._addSearchTimer = setTimeout(function () { self._searchBooks(q); }, 400);
        },
        _searchBooks: function (q) {
          var self = this;
          this.state.addSearching = true;
          this._renderAddResults();
          var merged = [];
          var remaining = 2;
          function done() {
            if (--remaining === 0) {
              self.state.addSearching = false;
              if (self.state.addQuery.trim() === q) {
                self.state.addResults = merged;
                self._renderAddResults();
              }
            }
          }

          fetch("/nodejs/GoogleBooksProxyServer/search?q=" + encodeURIComponent(q) + "&maxResults=8", { credentials: "include" })
            .then(function (r) { return r.ok ? r.json() : { items: [] }; })
            .then(function (data) {
              (data.items || []).forEach(function (it) {
                var vi = it.volumeInfo || {};
                var ids = vi.industryIdentifiers || [];
                var isbn13 = ids.filter(function (i) { return i.type === "ISBN_13"; })[0];
                var isbn10 = ids.filter(function (i) { return i.type === "ISBN_10"; })[0];
                merged.push({
                  title: vi.title || "Untitled",
                  author: (vi.authors || []).join(", ") || "Unknown",
                  description: vi.description || "",
                  isbn: (isbn13 || isbn10 || {}).identifier || null,
                  // Google's thumbnail URLs come back as plain http:// --
                  // confirmed live (books-template.md Research Finding #3)
                  // -- force https: or this mixed-content-blocks once this
                  // app is served over https.
                  coverUrl: vi.imageLinks && vi.imageLinks.thumbnail ? vi.imageLinks.thumbnail.replace(/^http:/, "https:") : null,
                  coverSource: "google",
                });
              });
            }).catch(function () {}).then(done);

          fetch("https://openlibrary.org/search.json?q=" + encodeURIComponent(q) + "&limit=8")
            .then(function (r) { return r.ok ? r.json() : { docs: [] }; })
            .then(function (data) {
              (data.docs || []).forEach(function (doc) {
                merged.push({
                  title: doc.title || "Untitled",
                  author: (doc.author_name || []).join(", ") || "Unknown",
                  description: "",
                  isbn: (doc.isbn || [])[0] || null,
                  coverUrl: doc.cover_i ? ("https://covers.openlibrary.org/b/id/" + doc.cover_i + "-M.jpg") : null,
                  coverSource: "openlibrary",
                });
              });
            }).catch(function () {}).then(done);
        },
        _addBookFromResult: function (result) {
          var self = this;
          var data = {
            title: result.title, author: result.author, shelf: "want", rating: 0,
            description: result.description, coverUrl: result.coverUrl, coverSource: result.coverSource,
            isbn: result.isbn, isPublic: true,
          };
          lively.identity.fileCrypto.createBook(data, function (err, created) {
            if (err) { console.warn("[Books] could not create book:", err.message); return; }
            lively.identity.fileCrypto.addPointerToFolder(self.booksLibraryHandle, self.booksLibraryObjId, { refType: "book", refObjId: created.objId }, function (err2, ptr) {
              if (err2) { console.warn("[Books] could not add to library:", err2.message); return; }
              self.state.books.push(Object.assign({ objId: created.objId, libraryPointerId: ptr.id }, data));
              self.state.addOpen = false;
              self._renderAddModal();
              self._renderSidebar();
              self._renderGrid();
            });
          });
        },
      },

      "book detail",
      {
        _currentBook: function () {
          var id = this.state.detailObjId;
          return this.state.books.filter(function (b) { return b.objId === id; })[0] || null;
        },
        _openBook: function (objId) {
          this.state.detailObjId = objId;
          this.state.comments = [];
          this.state.commentDraft = "";
          this._dom.commentInput.value = "";
          this._renderDetailModal();
          this._loadComments(objId);
        },
        _closeBook: function () {
          this.state.detailObjId = null;
          this._renderDetailModal();
        },
        _patchCurrentBook: function (patch) {
          var book = this._currentBook();
          if (!book || !this.state.isOwner) return;
          Object.assign(book, patch);
          this._renderGrid();
          this._renderDetailModal();
          lively.identity.fileCrypto.updateBook(this.booksLibraryHandle, book.objId, patch, function (err) {
            if (err) console.warn("[Books] could not save book:", err.message);
          });
        },
        _setRating: function (n) { this._patchCurrentBook({ rating: n }); },
        _setShelf: function (shelf) { this._patchCurrentBook({ shelf: shelf }); this._renderSidebar(); },
        _toggleBookPrivacy: function () {
          var book = this._currentBook();
          if (!book || !this.state.isOwner) return;
          if (this._effectiveVisibility(book).locked) return; // locked by a list, no-op
          this._patchCurrentBook({ isPublic: !book.isPublic });
        },
        _toggleBookInList: function (listObjId) {
          var book = this._currentBook();
          if (!book || !this.state.isOwner) return;
          var list = this.state.lists.filter(function (l) { return l.objId === listObjId; })[0];
          if (!list) return;
          var self = this;
          var existing = list.bookEntries.filter(function (e) { return e.bookObjId === book.objId; })[0];
          if (existing) {
            list.bookEntries = list.bookEntries.filter(function (e) { return e !== existing; });
            this._renderDetailModal(); this._renderGrid();
            lively.identity.fileCrypto.removeFileFromFolder(this.booksLibraryHandle, listObjId, existing.pointerId, function (err) {
              if (err) console.warn("[Books] could not remove from list:", err.message);
            });
          } else {
            lively.identity.fileCrypto.addPointerToFolder(this.booksLibraryHandle, listObjId, { refType: "book", refObjId: book.objId }, function (err, ptr) {
              if (err) { console.warn("[Books] could not add to list:", err.message); return; }
              list.bookEntries.push({ pointerId: ptr.id, bookObjId: book.objId });
              self._renderDetailModal(); self._renderGrid();
            });
          }
        },
        _deleteCurrentBook: function () {
          var book = this._currentBook();
          if (!book || !this.state.isOwner) return;
          var self = this;
          lively.identity.fileCrypto.deleteBook(this.booksLibraryHandle, book.objId, function (err) {
            if (err) { console.warn("[Books] could not delete book:", err.message); return; }
            lively.identity.fileCrypto.removeFileFromFolder(self.booksLibraryHandle, self.booksLibraryObjId, book.libraryPointerId, function () {});
            self.state.lists.forEach(function (l) {
              var entry = l.bookEntries.filter(function (e) { return e.bookObjId === book.objId; })[0];
              if (entry) {
                l.bookEntries = l.bookEntries.filter(function (e) { return e !== entry; });
                lively.identity.fileCrypto.removeFileFromFolder(self.booksLibraryHandle, l.objId, entry.pointerId, function () {});
              }
            });
            self.state.books = self.state.books.filter(function (b) { return b.objId !== book.objId; });
            self.state.detailObjId = null;
            self._renderDetailModal(); self._renderSidebar(); self._renderGrid();
          });
        },
      },

      "reviews & notes",
      {
        _itemUrl: function (objId, suffix) {
          return "/@" + encodeURIComponent(this.booksLibraryHandle) + "/" + encodeURIComponent(objId) + suffix;
        },
        _loadComments: function (objId) {
          var self = this;
          this.state.commentsLoading = true;
          this._renderDetailModal();
          fetch(this._itemUrl(objId, "/comments?limit=50"), { credentials: "include" })
            .then(function (r) { return r.ok ? r.json() : { comments: [] }; })
            .then(function (data) {
              if (self.state.detailObjId !== objId) return; // selection moved on
              self.state.comments = data.comments || [];
              self.state.commentsLoading = false;
              self._renderDetailModal();
            }).catch(function () {
              if (self.state.detailObjId !== objId) return;
              self.state.commentsLoading = false;
              self._renderDetailModal();
            });
        },
        _postComment: function () {
          var text = (this.state.commentDraft || "").trim();
          var objId = this.state.detailObjId;
          if (!text || !objId) return;
          var self = this;
          fetch(this._itemUrl(objId, "/comments"), {
            method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: text }),
          }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
            .then(function () {
              self.state.commentDraft = "";
              self._dom.commentInput.value = "";
              self._loadComments(objId);
            }).catch(function (e) { console.warn("[Books] could not post review:", e.message); });
        },
      },

      "lists",
      {
        _startNewList: function () {
          this.state.newListOpen = true;
          this.state.newListName = "";
          this.state.newListVisibility = "public";
          this.state.newListShareHandles = [];
          this.state.newListShareDraft = "";
          this._renderSidebar();
          if (this._dom.newListNameInput) this._dom.newListNameInput.focus();
        },
        _cancelNewList: function () {
          this.state.newListOpen = false;
          this._renderSidebar();
        },
        _setNewListVisibility: function (v) {
          this.state.newListVisibility = v;
          this._renderSidebar();
        },
        _addNewListShareHandle: function () {
          var h = (this.state.newListShareDraft || "").trim().replace(/^@/, "");
          if (!h) return;
          if (this.state.newListShareHandles.indexOf(h) === -1) this.state.newListShareHandles.push(h);
          this.state.newListShareDraft = "";
          this._renderSidebar();
        },
        _removeNewListShareHandle: function (h) {
          this.state.newListShareHandles = this.state.newListShareHandles.filter(function (x) { return x !== h; });
          this._renderSidebar();
        },
        _confirmNewList: function () {
          var name = (this.state.newListName || "").trim();
          if (!name) return;
          var self = this;
          var vis = this.state.newListVisibility;

          function withRecipients(cb) {
            if (vis !== "shared" || !self.state.newListShareHandles.length) return cb([]);
            self._resolveRecipientPubKeys(self.state.newListShareHandles, function (err, result) {
              cb(result ? result.resolved : []);
            });
          }

          withRecipients(function (recipients) {
            lively.identity.fileCrypto.createFolder(name, { visibility: vis, recipients: recipients }, function (err, created) {
              if (err) { console.warn("[Books] could not create list:", err.message); return; }
              lively.identity.fileCrypto.addPointerToFolder(self.booksLibraryHandle, self.booksLibraryObjId, { refType: "list", refObjId: created.objId }, function (err2, ptr) {
                if (err2) { console.warn("[Books] could not register list:", err2.message); return; }
                self.state.lists.push({
                  objId: created.objId, libraryPointerId: ptr.id, name: name,
                  // createFolder derives the ACTUAL visibility from whether
                  // any recipient wraps landed (same rule setFolderVisibility
                  // uses) -- 'shared' with zero resolved recipients silently
                  // collapses to 'private'; reflect that here rather than
                  // trusting the requested `vis` blindly.
                  visibility: recipients.length ? "shared" : (vis === "public" ? "public" : "private"),
                  recipients: recipients.map(function (r) { return r.did; }), bookEntries: [],
                });
                recipients.forEach(function (r) { self._didHandleMap[r.did] = r.handle; });
                self.state.newListOpen = false;
                self.state.filterType = "list"; self.state.filterKey = created.objId;
                self._renderSidebar(); self._renderGrid();
              });
            });
          });
        },

        // 'shared' isn't a directly click-cycled state -- FileCrypto's
        // folder model derives visibility:'shared' from having >=1 real
        // sealed recipient (setFolderVisibility('shared') with zero
        // recipients just collapses back to 'private', confirmed by
        // reading its own record-building branch) -- so this toggle only
        // ever flips private<->public; a list becomes Shared by adding its
        // first real recipient (_addShareToActiveList below), which flips
        // envelope.visibility to 'shared' as a side effect of shareFolder.
        _toggleActiveListVisibility: function () {
          if (this.state.filterType !== "list" || !this.state.isOwner) return;
          var listObjId = this.state.filterKey;
          var list = this.state.lists.filter(function (l) { return l.objId === listObjId; })[0];
          if (!list) return;
          var next = list.visibility === "public" ? "private" : "public";
          var self = this;
          lively.identity.fileCrypto.setFolderVisibility(this.booksLibraryHandle, listObjId, next, {}, function (err) {
            if (err) { console.warn("[Books] could not change list visibility:", err.message); return; }
            list.visibility = next;
            list.recipients = [];
            self._renderSidebar(); self._renderGrid();
          });
        },
        _addShareToActiveList: function () {
          var listObjId = this.state.filterKey;
          var list = this.state.lists.filter(function (l) { return l.objId === listObjId; })[0];
          var h = (this.state.shareDraft || "").trim().replace(/^@/, "");
          if (!list || !h || !this.state.isOwner) return;
          var self = this;
          this._resolveRecipientPubKeys([h], function (err, result) {
            var entry = result && result.resolved[0];
            if (!entry) { console.warn("[Books] could not resolve @" + h); return; }
            lively.identity.fileCrypto.shareFolder(self.booksLibraryHandle, listObjId, [entry], function (err2) {
              if (err2) { console.warn("[Books] could not share list:", err2.message); return; }
              if (list.recipients.indexOf(entry.did) === -1) list.recipients.push(entry.did);
              list.visibility = "shared";
              self._didHandleMap[entry.did] = entry.handle;
              self.state.shareDraft = "";
              self._renderSidebar(); self._renderGrid();
            });
          });
        },
        _removeShareFromActiveList: function (did) {
          var listObjId = this.state.filterKey;
          var list = this.state.lists.filter(function (l) { return l.objId === listObjId; })[0];
          if (!list || !this.state.isOwner) return;
          var self = this;
          lively.identity.fileCrypto.revokeFolderRecipient(this.booksLibraryHandle, listObjId, did, function (err, result) {
            if (err) { console.warn("[Books] could not remove share:", err.message); return; }
            list.recipients = list.recipients.filter(function (d) { return d !== did; });
            list.visibility = result.remaining ? "shared" : "private";
            self._renderSidebar(); self._renderGrid();
          });
        },

        // Resolves each @handle to { did, handle, x25519PublicKey } for
        // shareFolder/createFolder's recipients list -- Books.js's own
        // copy of PostCardEditor.js's _resolveRecipientPubKeys (per
        // books-template.md's Research Finding #2 note: "either factor
        // this out... or write Books.js's own copy"), minus its autosave-
        // driven TTL cache since list-sharing here is an infrequent,
        // explicit user action rather than a 2s-debounced loop. Includes
        // the same CID-integrity check on the fetched profile envelope
        // before trusting its key (postcard-audit F22).
        // Calls thenDo(null, { resolved: [...], failed: [handle,...] }).
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
                      console.warn("[Books] Profile envelope for @" + handle + " failed CID integrity check -- refusing to seal to its accountX25519Pub");
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

      "rendering",
      {
        _renderAll: function () {
          this._renderHeader();
          this._renderSidebar();
          this._renderGrid();
          this._renderDetailModal();
          this._renderAddModal();
        },

        _renderHeader: function () {
          if (this._dom.titleEl) this._dom.titleEl.textContent = this._worldName();
          var n = this.state.books.length;
          this._dom.subEl.textContent = this.state.loaded ? (n + (n === 1 ? " book" : " books")) : "";
          this._dom.addBookBtn.style.display = this.state.isOwner ? "" : "none";
          this._renderSwatches();
        },

        _renderSwatches: function () {
          var self = this;
          THEME_KEYS.forEach(function (key) {
            var sw = self._dom.swatches[key];
            sw.className = key === self.state.theme ? "swatch is-active" : "swatch";
          });
        },

        _renderSidebar: function () {
          var self = this;
          var theme = this.state;

          // shelves
          var shelfRow = this._dom.shelfRow;
          this._clear(shelfRow);
          var counts = { all: this.state.books.length };
          SHELF_KEYS.forEach(function (k) {
            counts[k] = self.state.books.filter(function (b) { return b.shelf === k; }).length;
          });
          ["all"].concat(SHELF_KEYS).forEach(function (key) {
            var active = self.state.filterType === "shelf" && self.state.filterKey === key;
            var item = self._el("button", active ? "side-item is-active" : "side-item", shelfRow);
            self._text("span", "side-name", SHELF_LABELS[key], item);
            self._text("span", "count", String(counts[key]), item);
            item.addEventListener("click", function () { self._setFilter("shelf", key); });
          });

          // lists
          var listRow = this._dom.listRow;
          this._clear(listRow);
          this.state.lists.forEach(function (l) {
            var active = self.state.filterType === "list" && self.state.filterKey === l.objId;
            var item = self._el("button", active ? "side-item is-active" : "side-item", listRow);
            self._text("span", "side-name", l.name, item);
            var badge = self._text("span", "vis-badge " + l.visibility, VIS_LABEL[l.visibility], item);
            item.addEventListener("click", function () { self._setFilter("list", l.objId); });
            item.title = l.name + " · " + VIS_LABEL[l.visibility];
          });

          this._dom.newListBtn.style.display = this.state.isOwner ? "" : "none";

          var formWrap = this._dom.newListFormWrap;
          this._clear(formWrap);
          if (this.state.newListOpen && this.state.isOwner) {
            var form = this._el("div", "newlist-form", formWrap);
            var nameInput = this._el("input", "input", form);
            nameInput.type = "text";
            nameInput.placeholder = "List name…";
            nameInput.value = this.state.newListName;
            this._dom.newListNameInput = nameInput;
            nameInput.addEventListener("input", function () { self.state.newListName = nameInput.value; });
            nameInput.addEventListener("keydown", function (e) {
              if (e.key === "Enter") self._confirmNewList();
              if (e.key === "Escape") self._cancelNewList();
            });

            var visRow = this._el("div", "newlist-vis-row", form);
            ["private", "shared", "public"].forEach(function (v) {
              var b = self._text("button", self.state.newListVisibility === v ? "btn btn-outline is-active" : "btn btn-outline", VIS_LABEL[v], visRow);
              b.addEventListener("click", function () { self._setNewListVisibility(v); });
            });

            if (this.state.newListVisibility === "shared") {
              var shareWrap = this._el("div", null, form);
              var chipRow = this._el("div", "chip-row", shareWrap);
              chipRow.style.marginBottom = "6px";
              this.state.newListShareHandles.forEach(function (h) {
                var chip = self._el("span", "share-chip", chipRow);
                chip.appendChild(document.createTextNode("@" + h));
                var rm = self._el("button", null, chip);
                rm.textContent = "×";
                rm.setAttribute("aria-label", "Remove");
                rm.addEventListener("click", function () { self._removeNewListShareHandle(h); });
              });
              var shareInputRow = this._el("div", null, shareWrap);
              shareInputRow.style.display = "flex";
              shareInputRow.style.gap = "6px";
              var shareInput = this._el("input", "input", shareInputRow);
              shareInput.type = "text";
              shareInput.placeholder = "@handle to share with…";
              shareInput.value = this.state.newListShareDraft;
              shareInput.addEventListener("input", function () { self.state.newListShareDraft = shareInput.value; });
              shareInput.addEventListener("keydown", function (e) { if (e.key === "Enter") self._addNewListShareHandle(); });
              var addShareBtn = this._text("button", "btn btn-primary", "Add", shareInputRow);
              addShareBtn.style.flexShrink = "0";
              addShareBtn.addEventListener("click", function () { self._addNewListShareHandle(); });
            }

            var createBtn = this._text("button", "btn btn-primary", "Create List", form);
            createBtn.addEventListener("click", function () { self._confirmNewList(); });
          }
        },

        _renderGrid: function () {
          var self = this;
          var list = this._filteredBooks();

          this._dom.gate.style.display = this.state.loaded ? "none" : "";
          this._dom.empty.style.display = this.state.loaded && list.length === 0 ? "" : "none";
          this._dom.grid.style.display = this.state.loaded && list.length > 0 ? "" : "none";

          // main-area header (title/count/list-privacy/share row)
          var filterList = this.state.filterType === "list"
            ? this.state.lists.filter(function (l) { return l.objId === self.state.filterKey; })[0]
            : null;
          this._dom.selectionTitle.textContent = filterList ? filterList.name : SHELF_LABELS[this.state.filterKey] || "All Books";
          this._dom.selectionCount.textContent = list.length + (list.length === 1 ? " book" : " books");

          if (filterList && this.state.isOwner) {
            this._dom.listPrivacyBtn.style.display = "";
            this._dom.listPrivacyBtn.textContent = VIS_LABEL[filterList.visibility];
            this._dom.listPrivacyBtn.className = "privacy-pill vis-badge " + filterList.visibility;
          } else {
            this._dom.listPrivacyBtn.style.display = "none";
          }

          this._clear(this._dom.shareRow);
          if (filterList && filterList.visibility === "shared" && this.state.isOwner) {
            this._dom.shareRow.style.display = "";
            this._text("span", "text-faint", "Shared with", this._dom.shareRow);
            filterList.recipients.forEach(function (did) {
              var chip = self._el("span", "share-chip", self._dom.shareRow);
              chip.appendChild(document.createTextNode("@" + (self._didHandleMap[did] || did.slice(0, 10))));
              var rm = self._el("button", null, chip);
              rm.textContent = "×";
              rm.addEventListener("click", function () { self._removeShareFromActiveList(did); });
            });
            var shareInput = this._el("input", "input", this._dom.shareRow);
            shareInput.type = "text";
            shareInput.placeholder = "@handle…";
            shareInput.value = this.state.shareDraft;
            shareInput.addEventListener("input", function () { self.state.shareDraft = shareInput.value; });
            shareInput.addEventListener("keydown", function (e) { if (e.key === "Enter") self._addShareToActiveList(); });
            var addBtn = this._text("button", "btn btn-primary", "Add", this._dom.shareRow);
            addBtn.addEventListener("click", function () { self._addShareToActiveList(); });
          } else {
            this._dom.shareRow.style.display = "none";
          }

          this._clear(this._dom.grid);
          list.forEach(function (book) {
            self._dom.grid.appendChild(self._buildBookTile(book));
          });
        },

        _buildBookTile: function (book) {
          var self = this;
          var tile = this._el("button", "book-tile", null);
          tile.addEventListener("click", function () { self._openBook(book.objId); });

          var cover = this._el("div", "book-cover", tile);
          var coverText = this._el("div", "book-cover-text", cover);
          coverText.appendChild(document.createTextNode(book.title));
          var coverAuthor = this._el("div", "book-cover-author", coverText);
          coverAuthor.textContent = book.author;
          this._applyCover(cover, coverText, book);
          this._text("div", "shelf-badge", SHELF_LABELS[book.shelf] || book.shelf, cover);

          var infoWrap = this._el("div", null, tile);
          this._text("div", "book-title", book.title, infoWrap);
          this._text("div", "book-author", book.author, infoWrap);
          var stars = "";
          for (var i = 1; i <= 5; i++) stars += (i <= (book.rating || 0)) ? "★" : "☆";
          this._text("div", "book-stars", stars, infoWrap);

          return tile;
        },

        _renderDetailModal: function () {
          var self = this;
          var book = this._currentBook();
          this._dom.detailBackdrop.style.display = book ? "" : "none";
          if (!book) return;

          this._clear(this._dom.detailCoverText);
          this._dom.detailCoverText.appendChild(document.createTextNode(book.title));
          this._dom.detailCoverText.appendChild(this._dom.detailCoverAuthor);
          this._dom.detailCoverAuthor.textContent = book.author;
          this._applyCover(this._dom.detailCover, this._dom.detailCoverText, book);

          this._clear(this._dom.shelfPillRow);
          SHELF_KEYS.forEach(function (s) {
            var active = s === book.shelf;
            var b = self._text("button", active ? "btn btn-outline is-active" : "btn btn-outline", SHELF_LABELS[s], self._dom.shelfPillRow);
            if (!self.state.isOwner) b.disabled = true;
            b.addEventListener("click", function () { self._setShelf(s); });
          });

          this._dom.detailTitle.textContent = book.title;
          this._dom.detailAuthor.textContent = "by " + book.author;

          this._clear(this._dom.starsRow);
          for (var n = 1; n <= 5; n++) {
            (function (n) {
              var b = self._el("button", "star-btn" + (n <= (book.rating || 0) ? " filled" : ""), self._dom.starsRow);
              b.textContent = "★";
              b.setAttribute("aria-label", "Rate " + n);
              if (!self.state.isOwner) b.disabled = true;
              b.addEventListener("click", function () { self._setRating(n); });
            })(n);
          }

          this._dom.detailDesc.textContent = book.description || "";

          this._clear(this._dom.listChipRow);
          this.state.lists.forEach(function (l) {
            var member = l.bookEntries.some(function (e) { return e.bookObjId === book.objId; });
            var chip = self._text("button", member ? "btn btn-outline is-active" : "btn btn-outline", l.name + " · " + VIS_LABEL[l.visibility], self._dom.listChipRow);
            chip.style.fontSize = "11.5px";
            if (!self.state.isOwner) chip.disabled = true;
            chip.addEventListener("click", function () { self._toggleBookInList(l.objId); });
          });

          var eff = this._effectiveVisibility(book);
          var canSeeReviews = this.state.isOwner || eff.visibility === "public";

          this._dom.detailPrivacyBtn.textContent = VIS_LABEL[eff.visibility];
          this._dom.detailPrivacyBtn.className = "privacy-pill vis-badge " + eff.visibility;
          this._dom.detailPrivacyBtn.style.cursor = (this.state.isOwner && !eff.locked) ? "pointer" : "default";
          this._dom.detailPrivacyBtn.style.opacity = eff.locked ? "0.7" : "1";
          this._dom.detailPrivacyBtn.style.display = this.state.isOwner ? "" : "none";

          var note;
          if (eff.locked) {
            note = eff.visibility === "shared"
              ? ('Shared — visible to the people in the "' + eff.bindingList.name + '" list.')
              : ('Private — in the private list "' + eff.bindingList.name + '". Remove it from that list to allow making this public.');
          } else if (eff.visibility === "public") {
            note = "Visible to anyone who visits this book.";
          } else {
            note = "Only visible to you.";
          }
          this._dom.privacyNote.textContent = this.state.isOwner ? note : "";

          this._clear(this._dom.commentList);
          if (canSeeReviews) {
            if (this.state.commentsLoading) {
              this._text("div", "text-faint", "Loading…", this._dom.commentList);
            } else if (!this.state.comments.length) {
              this._text("div", "text-faint", "No reviews yet.", this._dom.commentList);
            } else {
              this.state.comments.forEach(function (c) {
                var row = self._el("div", "comment-row", self._dom.commentList);
                var handle = c.handle || "someone";
                var avatar = self._el("div", "comment-avatar", row);
                avatar.textContent = handle.charAt(0).toUpperCase();
                var col = self._el("div", null, row);
                col.style.flex = "1"; col.style.minWidth = "0";
                var head = self._el("div", null, col);
                self._text("span", "comment-author", "@" + handle, head);
                self._text("span", "comment-date", self._formatDate(c.createdAt), head);
                self._text("div", "comment-text", c.body, col);
              });
            }
          }
          this._dom.commentForm.style.display = canSeeReviews ? "" : "none";
          if (!canSeeReviews) this._text("div", "text-faint", "Reviews & notes aren't visible here.", this._dom.commentList);

          this._dom.deleteBtn.style.display = this.state.isOwner ? "" : "none";
        },

        _formatDate: function (iso) {
          if (!iso) return "";
          try {
            var d = new Date(iso);
            return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
          } catch (e) { return ""; }
        },

        _renderAddResults: function () {
          var self = this;
          this._dom.addHint.textContent = this.state.addSearching ? "Searching…" : "Searching Google Books and Open Library…";
          this._clear(this._dom.addResultsEl);
          this.state.addResults.forEach(function (item) {
            var row = self._el("div", "add-result", self._dom.addResultsEl);
            var cover = self._el("div", "add-result-cover", row);
            if (item.coverUrl) {
              cover.style.backgroundImage = self._cssUrl(item.coverUrl);
            } else {
              cover.style.background = self._coverColorFor(item.title);
            }
            var col = self._el("div", null, row);
            col.style.flex = "1"; col.style.minWidth = "0";
            self._text("div", "add-result-title", item.title, col);
            self._text("div", "add-result-author", item.author, col);
            self._text("div", "add-result-src", "via " + (item.coverSource === "google" ? "Google Books" : "Open Library"), col);
            var addBtn = self._text("button", "btn btn-primary", "Add", row);
            addBtn.style.flexShrink = "0";
            addBtn.addEventListener("click", function () { self._addBookFromResult(item); });
          });
        },

        _renderAddModal: function () {
          this._dom.addBackdrop.style.display = this.state.addOpen ? "" : "none";
          this._renderAddResults();
        },
      },
    );

    BooksClass.open = function (optPos) {
      var m = new lively.books.Books(lively.rect(0, 0, 1280, 820));
      m.setName("Books");
      m.openInWorld(optPos || lively.morphic.World.current().visibleBounds().center().subPt(lively.pt(640, 410)));
      // Same post-attach re-fit as Gallery.js's open() -- _setup() (and the
      // _fitToWorld()/header render it runs) fires via
      // prepareForNewRenderContext as part of openInWorld()'s own addMorph
      // step, BEFORE this morph is actually linked into the world's owner
      // chain, so the first-pass title falls back to the default and
      // openInWorld's own position re-centering clobbers the fit-to-world
      // position just set. Re-running both now, with the morph genuinely
      // attached, settles both for real.
      m._fitToWorld();
      m._renderHeader();
      return m;
    };
  }); // end module('lively.books.Books')
