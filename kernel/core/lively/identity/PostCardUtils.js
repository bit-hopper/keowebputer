/**
 * lively.identity.PostCardUtils
 *
 * Shared client-side utilities for rendering ProseMirror snapshot JSON as HTML.
 * Used by PostCardView, WikiView and WikiHistory, so those stay in sync.
 *
 * NOT shared with the server: IdentityServer.js's `_pmNodeToHtml` is an
 * independent copy for static server-side rendering, and PostCardEditor.js's
 * ProseMirror `toDOM` specs are a third independent render path for the live
 * editor view. All three currently support a different subset of marks/nodes
 * (audit F21) — treat changes here as needing the same change made in both
 * other places until they're consolidated into one shared module.
 */

module('lively.identity.PostCardUtils')
  .requires()
  .toRun(function () {

    lively.identity = lively.identity || {};

    lively.identity.postCardUtils = {
      snapshotToHtml:      snapshotToHtml,
      pmNodeToHtml:        pmNodeToHtml,
      escapeHtml:          escapeHtml,
      identiconDataUrl:    identiconDataUrl,
      truncateDid:         truncateDid,
      lockGlyph:           lockGlyph,
      lockGlyphHtml:       lockGlyphHtml,
      truncateAddress:     truncateAddress,
      excerptText:         excerptText,
      buildPreviewSplit:   buildPreviewSplit,
      encodeLocation:      encodeLocation,
      sanitizeLocationCode: sanitizeLocationCode,
      hydrateEmbeddedParts: hydrateEmbeddedParts,
      hydrateAttachments:  hydrateAttachments,
      hydrateCodeCells:    hydrateCodeCells,
      hydrateLinkPreviews: hydrateLinkPreviews,
      hydrateLinkPreviewEmbeds: hydrateLinkPreviewEmbeds,
      fetchLinkPreview:    _fetchLinkPreview,
      peekLinkPreview:     peekLinkPreview,
      buildLinkPreviewCard: buildLinkPreviewCard,
      runCodeCell:         runCodeCell,
      stopCodeCell:        stopCodeCell,
      resetCodeCell:       resetCodeCell,
      provideCodeCellInput: provideCodeCellInput,
      codeCellLanguage:    codeCellLanguage,
      codeCellLanguageList: codeCellLanguageList,
      codeCellGlobal:      codeCellGlobal,
      codeCellLanguageLabel: codeCellLanguageLabel,
      createSchemeOutput:  createSchemeOutput,
      createTranscriptOutput: createSchemeOutput,
      openImageViewer:     openImageViewer,
    };

    // Code-cell language registry: the one place that says which languages a
    // `code_cell` node can hold and how each behaves, so the editor NodeView,
    // the read-only/hydrated render, the Template menu and the stylesheet read
    // a row instead of testing `language === 'scheme'`. Adding a language is
    // adding a row (plus its worker and highlight.js grammar).
    //
    // IdentityServer.js cannot load this module and keeps its own copy of the
    // same table (CODE_CELL_LANGUAGES there) for the static server render;
    // the two must match -- id, label, hljsId and hasReset are the fields the
    // server reads.
    //
    //   id               value of the node's `language` attr and of data-language
    //   label            badge text (icon, then name)
    //   hljsId           highlight.js grammar for the source
    //   insertLabel      Template menu row
    //   output           'python' = one-shot stdout/stderr/result pane;
    //                    'transcript' = ordered streamed transcript (createSchemeOutput)
    //   controller       dotted path of the worker singleton that runs the source
    //   confirmBeforeRun ask before running (the runtime has ambient access)
    //   hasReset         the page keeps one environment and offers a Reset button
    //   resetTitle       tooltip for that button
    //   cooperativeStop  Stop interrupts the run and the environment survives
    //   loadingText      status shown while the runtime loads (transcript languages)
    //   editing          dotted path of an editing helper with attach(textarea), or null
    //   graphics         true: the output pane may carry a turtle canvas (absent = false)
    //   badge            tint of the language badge
    //   help             optional note shown under the cell (lines separated by newlines), or absent
    var CODE_CELL_LANGUAGES = {
      python: {
        id: 'python', known: true, label: '🐍 Python', hljsId: 'python', insertLabel: 'Python code cell',
        output: 'python', controller: 'lively.identity.PyodideWorker',
        confirmBeforeRun: true, hasReset: false, resetTitle: '', cooperativeStop: false,
        loadingText: 'Loading Python runtime…', editing: null,
        badge: { background: '#fff4cc', color: '#7a5600', border: '#f3dc8a' },
      },
      scheme: {
        id: 'scheme', known: true, label: 'λ Scheme', hljsId: 'scheme', insertLabel: 'Scheme code cell',
        output: 'transcript', controller: 'lively.identity.SchemeWorker',
        confirmBeforeRun: false, hasReset: true, resetTitle: 'Start a fresh Scheme environment for this page',
        cooperativeStop: true, loadingText: 'Loading Scheme…', editing: 'lively.identity.SchemeEditing',
        badge: { background: '#ede7ff', color: '#5233b5', border: '#d6c9fb' },
      },
      sml: {
        id: 'sml', known: true, label: '🐪 ML', hljsId: 'sml', insertLabel: 'ML code cell',
        output: 'transcript', controller: 'lively.identity.MLWorker',
        confirmBeforeRun: false, hasReset: true, resetTitle: 'Start a fresh ML environment for this page',
        cooperativeStop: true, loadingText: 'Loading ML…', editing: null,
        help: "Glyphs accepted: → ⇒ ▷ for -> => :>, and α β γ for 'a 'b 'c. A line starting with • is a type box; ⊗ marks a box the book says is rejected.\nPragmas: (*# style: book|sml *)  (*# depth: N *)  (*# verdicts: on|off *)  (*# redundant: error|warning *)",
        badge: { background: '#fff0e0', color: '#8a4b00', border: '#f5d3a8' },
      },
      // Logo and TPN (LOGO.md): two rows, one controller, so one interpreter per page serves both and a procedure defined
      // in a tpn cell can be called from a logo cell. `graphics: true` marks a language whose output pane may carry a
      // turtle canvas (createSchemeOutput's graphicsHost); no other row sets it.
      logo: {
        id: 'logo', known: true, label: '🐢 Logo', hljsId: 'logo', insertLabel: 'Logo code cell',
        output: 'transcript', graphics: true, controller: 'lively.identity.LogoWorker',
        confirmBeforeRun: false, hasReset: true, resetTitle: 'Start a fresh Logo workspace for this page',
        cooperativeStop: true, loadingText: 'Loading Logo…', editing: null,
        help: "Berkeley Logo. Each line runs like a line typed at the Logo prompt, so an expression with nothing to use its value is an error, as in the books.",
        badge: { background: '#e3f6e8', color: '#1d6b36', border: '#b9e4c5' },
      },
      tpn: {
        id: 'tpn', known: true, label: '🐢 TPN', hljsId: 'tpn', insertLabel: 'Turtle Procedure Notation cell',
        output: 'transcript', graphics: true, controller: 'lively.identity.LogoWorker',
        confirmBeforeRun: false, hasReset: true, resetTitle: 'Start a fresh Logo workspace for this page',
        cooperativeStop: true, loadingText: 'Loading Logo…', editing: null,
        help: "Turtle Procedure Notation, the language of the book Turtle Geometry. Typed <- is accepted for the assignment arrow, and ^ is exponentiation.",
        badge: { background: '#e0f4f6', color: '#0e6573', border: '#b3dfe5' },
      },
    };

    // The row for a node's `language` attr. A missing/empty value is the
    // schema's default (python). Any other id this build has no row for is NOT
    // python: it comes back as a stand-in with known:false and no runtime, so
    // callers render the source as plain text with no Run button (a page
    // written by a newer build keeps its language intact, and Run never feeds
    // that source to the wrong interpreter).
    function codeCellLanguage(raw) {
      if (raw === undefined || raw === null || raw === '') raw = 'python';
      var id = String(raw);
      if (Object.prototype.hasOwnProperty.call(CODE_CELL_LANGUAGES, id)) return CODE_CELL_LANGUAGES[id];
      return {
        id: id, known: false, label: id.length > 40 ? id.slice(0, 40) + '…' : id, hljsId: null, insertLabel: null,
        output: 'none', controller: null, confirmBeforeRun: false, hasReset: false, resetTitle: '',
        cooperativeStop: false, loadingText: '', editing: null, badge: null,
      };
    }

    function codeCellLanguageList() {
      return Object.keys(CODE_CELL_LANGUAGES).map(function (id) { return CODE_CELL_LANGUAGES[id]; });
    }

    // A registry row's dotted path ('lively.identity.SchemeWorker') -> the object, or null.
    function codeCellGlobal(path) {
      if (!path) return null;
      var obj = typeof window !== 'undefined' ? window : null;
      var parts = path.split('.');
      for (var i = 0; obj && i < parts.length; i++) obj = obj[parts[i]];
      return obj || null;
    }

    // BUG FIX: the .lively-postcard-image/.lively-postcard-video max-width/
    // max-height sizing rules used to live ONLY inside PostCardEditor.js's
    // and WikiEditor.js's own instance-level style injection (guarded by
    // document.getElementById('lively-postcard-editor-style')) — which never
    // runs unless a PostCardEditor/WikiEditor is actually instantiated. Every
    // read-only render path (PostCardView, WikiView,
    // WikiHistory — none of which instantiate the editor just to display a
    // card) never got this CSS at all, so images/videos rendered at full
    // native pixel size, uncropped by their container. Harmless-looking for
    // a modest-sized photo, but a full-resolution video rendered many times
    // its intended embed size — confirmed live via a permalink page
    // (/@handle/objId) that never touches the editor. This module is
    // required (transitively or directly) by every one of those read paths,
    // so injecting it here — independently of whether the editor ever loads
    // — is the actual fix. The editors keep their own (now redundant, still
    // harmless — identical values) copy of the same rules; see this
    // function's values if the two ever need to be kept in sync.
    _ensureMediaStyle();

    // Stylesheet for code_cell (runnable cells; languages in CODE_CELL_LANGUAGES): the live editor's
    // NodeView and the read-only/hydrated render share these rules, so there is
    // exactly one copy. A cell is a light card: a header (language badge, Run /
    // Stop / Reset, status) over a dark source pane, over the output pane.
    // The cell root carries data-language so the badge can be tinted per language.
    function codeCellCss() {
      var cell = '.lively-code-cell-node';
      var mono = '"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace';
      var hl = '.lively-code-cell-source .hljs-';
      return [
        cell + '{border:1px solid #e2e5ee;border-radius:12px;margin:14px 0;background:#fff;overflow:hidden;' +
          'box-shadow:0 1px 2px rgba(20,24,40,.05),0 4px 14px rgba(20,24,40,.05);}',
        cell + '.lively-code-cell-selected{outline:2px solid #6c8cff;outline-offset:0;}',
        '.lively-code-cell-header{display:flex;align-items:center;gap:8px;padding:8px 12px;' +
          'background:linear-gradient(#fafbfd,#f3f5fa);border-bottom:1px solid #e8ebf2;font-size:12px;' +
          'font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}',
        // Language badge: a tinted pill (icon + name).
        '.lively-code-cell-badge{display:inline-flex;align-items:center;gap:5px;font-weight:600;font-size:11.5px;' +
          'padding:3px 10px;border-radius:999px;letter-spacing:.01em;background:#eef0f5;color:#4a5068;border:1px solid #d9dde8;}',
        codeCellLanguageList().map(function (def) {
          return cell + '[data-language="' + def.id + '"] .lively-code-cell-badge{background:' + def.badge.background +
            ';color:' + def.badge.color + ';border-color:' + def.badge.border + ';}';
        }).join(''),
        // Buttons: Run is the primary action; icons are CSS glyphs so the button text stays "Run"/"Stop"/"Reset".
        '.lively-code-cell-run-btn,.lively-code-cell-stop-btn,.lively-code-cell-reset-btn{cursor:pointer;' +
          'font-family:inherit;font-size:11.5px;font-weight:600;line-height:1.4;padding:3px 12px;border-radius:999px;' +
          'border:1px solid #d9dde8;background:#fff;color:#4a5068;}',
        '.lively-code-cell-run-btn:before{content:"\\25B6";font-size:8px;margin-right:6px;vertical-align:1px;}',
        '.lively-code-cell-stop-btn:before{content:"\\25A0";font-size:8px;margin-right:6px;vertical-align:1px;}',
        '.lively-code-cell-reset-btn:before{content:"\\21BA";font-size:11px;margin-right:5px;}',
        '.lively-code-cell-run-btn{background:#1a7f37;border-color:#17702f;color:#fff;}',
        '.lively-code-cell-run-btn:hover{background:#16692d;}',
        '.lively-code-cell-stop-btn{display:none;background:#c0392b;border-color:#a93226;color:#fff;}',
        '.lively-code-cell-stop-btn:hover{background:#a93226;}',
        '.lively-code-cell-reset-btn:hover{background:#f4f5f9;}',
        '.lively-code-cell-status{margin-left:auto;color:#7a8094;font-size:11.5px;}',
        // Source pane: dark, with its own token palette (the highlight.js theme loaded for
        // ordinary code blocks is a light one and would paint a white box in here).
        // The pane floats inside the card with a margin on each side and soft corners.
        '.lively-code-cell-source{display:block;width:calc(100% - 24px);box-sizing:border-box;margin:10px 12px;border:none;outline:none;' +
          'background:#1e2230;color:#d7dae0;font-family:' + mono + ';font-size:13px;line-height:1.55;' +
          'padding:14px 16px;tab-size:2;overflow-x:auto;border-radius:10px;}',
        // Height is set from the content by WikiEditor's code-cell NodeView (autosize), so no drag handle.
        'textarea.lively-code-cell-source{resize:none;min-height:72px;caret-color:#fff;}',
        // Scheme editor (SchemeEditing.attach): the textarea goes transparent over a backdrop
        // that paints the matching-bracket highlight. The backdrop copies the textarea's font
        // metrics exactly; no wrapping so columns line up with the indentation logic.
        '.lively-code-cell-editwrap{position:relative;background:#1e2230;margin:10px 12px;border-radius:10px;overflow:hidden;}',
        '.lively-code-cell-editwrap textarea.lively-code-cell-source{position:relative;background:transparent;white-space:pre;' +
          'width:100%;margin:0;border-radius:10px;}',
        '.lively-code-cell-backdrop{position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;pointer-events:none;}',
        '.lively-code-cell-backdrop-inner{box-sizing:border-box;padding:14px 16px;margin:0;font-family:' + mono + ';' +
          'font-size:13px;line-height:1.55;tab-size:2;white-space:pre;color:transparent;}',
        '.lively-code-cell-backdrop-inner mark{background:rgba(97,175,239,.38);color:transparent;border-radius:2px;' +
          'box-shadow:0 0 0 1px rgba(97,175,239,.55);}',
        '.lively-code-cell-backdrop-inner mark.bad{background:rgba(229,115,104,.42);box-shadow:0 0 0 1px rgba(229,115,104,.7);}',
        '.lively-code-cell-source code.hljs{display:inline;background:transparent;color:inherit;padding:0;font:inherit;}',
        hl + 'keyword,' + hl + 'built_in{color:#c678dd;}',
        hl + 'name,' + hl + 'title,' + hl + 'function{color:#61afef;}',
        hl + 'string,' + hl + 'regexp{color:#98c379;}',
        hl + 'number,' + hl + 'literal{color:#d19a66;}',
        hl + 'symbol,' + hl + 'attr,' + hl + 'variable,' + hl + 'params{color:#e5c07b;}',
        hl + 'comment{color:#7f848e;font-style:italic;}',
        hl + 'meta{color:#56b6c2;}',
        '.lively-code-cell-output{padding:12px 16px;border-top:1px solid #e8ebf2;background:#fcfcfe;color:#2b2f3e;' +
          'font-family:' + mono + ';font-size:12.5px;line-height:1.5;}',
        '.lively-code-cell-output.lively-code-cell-output-empty{color:#9aa0b3;font-style:italic;}',
        '.lively-code-cell-output pre{margin:0 0 6px 0;white-space:pre-wrap;word-break:break-word;}',
        '.lively-code-cell-output pre:last-child{margin-bottom:0;}',
        '.lively-code-cell-output pre.lively-code-cell-stderr{color:#b3261e;background:#fdf0ee;' +
          'border-left:3px solid #e57368;padding:6px 10px;border-radius:0 6px 6px 0;}',
        '.lively-code-cell-output pre.lively-code-cell-value{color:#1a5fb4;}',
        '.lively-code-cell-output pre.lively-code-cell-value:before{content:"\\21D2  ";color:#9aa0b3;}',
        '.lively-code-cell-output pre.lively-code-cell-note{color:#8a90a3;font-style:italic;}',
        '.lively-code-cell-output pre.lively-code-cell-warn{color:#8a5a00;background:#fff8e6;' +
          'border-left:3px solid #e6b84a;padding:6px 10px;border-radius:0 6px 6px 0;}',
        '.lively-code-cell-output pre.lively-code-cell-tone-ok{color:#1b7a3a;font-style:normal;}',
        '.lively-code-cell-output pre.lively-code-cell-tone-bad{color:#b3261e;font-style:normal;}',
        '.lively-code-cell-output .lively-code-cell-errclass{font-weight:600;margin-right:6px;}',
        '.lively-code-cell-help{padding:6px 16px 8px;border-top:1px solid #eef0f5;background:#fcfcfe;color:#8a90a3;' +
          'font-size:11px;line-height:1.5;white-space:pre-wrap;}',
        '.lively-code-cell-output pre.lively-code-cell-echo{color:#8a90a3;}',
        '.lively-code-cell-input-row{display:flex;gap:6px;margin:4px 0;}',
        '.lively-code-cell-input-row input{flex:1;min-width:0;font-family:' + mono + ';font-size:12px;' +
          'padding:4px 10px;border:1px solid #c8cde0;border-radius:8px;outline:none;}',
        '.lively-code-cell-input-row input:focus{border-color:#6c8cff;box-shadow:0 0 0 2px rgba(108,140,255,.2);}',
        '.lively-code-cell-input-row button{cursor:pointer;border:1px solid #d9dde8;border-radius:999px;' +
          'background:#fff;color:#4a5068;font-size:11px;font-weight:600;padding:3px 12px;}',
        '.lively-code-cell-output img{max-width:100%;display:block;margin:4px 0;}',
        // Turtle canvas (graphics languages, createSchemeOutput's graphicsHost). Square, Berkeley's black paper; the pane
        // scales it, so the width is a ceiling, not a size.
        '.lively-code-cell-graphics{margin:0 0 8px 0;}',
        '.lively-code-cell-canvas{display:block;width:100%;max-width:480px;aspect-ratio:1/1;background:#000;border-radius:8px;}',
        // (TurtleCanvas.js adds a second canvas on top for the turtle and this toolbar underneath; the host is then
        // position:relative with the overlay stretched over the picture, so the host must not be wider than the picture.)
        '.lively-code-cell-graphics{max-width:480px;}',
        '.lively-code-cell-graphics-bar{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}',
        '.lively-code-cell-graphics-bar button{cursor:pointer;border:1px solid #d9dde8;border-radius:999px;background:#fff;color:#4a5068;font-size:11px;font-weight:600;padding:3px 12px;}',
        '.lively-code-cell-graphics-bar button.lively-code-cell-toggle-on{background:#e3f6e8;border-color:#b9e4c5;color:#1d6b36;}',
      ].join('');
    }

    function _ensureMediaStyle() {
      if (document.getElementById('lively-postcard-media-style')) return;
      var styleEl = document.createElement('style');
      styleEl.id = 'lively-postcard-media-style';
      styleEl.textContent =
        '.lively-postcard-image{max-width:100%;max-height:320px;vertical-align:middle;border-radius:4px;}' +
        '.lively-postcard-video{display:block;width:100%;max-height:480px;object-fit:contain;background:#000;border-radius:4px;}' +
        '.lively-postcard-audio{max-width:100%;width:320px;display:block;}' +
        // Photo galleries (see blocksToHtml): fixed-size cells, each photo
        // zoomed to fill its cell (object-fit:cover, edges may be cropped).
        // 1 = full width, natural shape; 2 = side by side; 3 = one tall left
        // + two stacked right; 4 = 2x2.
        '.lively-media-grid{display:grid;gap:4px;margin:6px 0;}' +
        '.lively-media-grid.lively-media-n2{grid-template-columns:1fr 1fr;height:280px;}' +
        '.lively-media-grid.lively-media-n3{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;height:380px;}' +
        '.lively-media-grid.lively-media-n3 .lively-media-cell:first-child{grid-row:1 / span 2;}' +
        '.lively-media-grid.lively-media-n4{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;height:380px;}' +
        '.lively-media-cell{position:relative;overflow:hidden;border-radius:4px;min-height:0;min-width:0;}' +
        '.lively-postcard-view-content img.lively-postcard-image{cursor:zoom-in;}' +
        '.lively-media-cell img.lively-postcard-image{display:block;width:100%;height:100%;max-width:none;max-height:none;object-fit:cover;border-radius:0;}' +
        '.lively-media-grid.lively-media-n1 .lively-media-cell img.lively-postcard-image{height:auto;max-height:480px;}' +
        '.lively-embedded-part{position:relative;min-height:32px;margin:4px 0;padding:4px;}' +
        '.lively-embedded-part.lively-embed-error{color:#c33;font-style:italic;padding:8px;}' +
        // Links inside a wiki page or postcard (read-only view + editor +
        // preview) are pink, not the browser's default blue. The editor's
        // ProseMirror container class is shared between PostCardEditor and
        // WikiEditor, so the selector list names each container explicitly.
        // Link-preview cards are also <a> elements but style their own text,
        // so they're excluded.
        '.lively-wiki-view-content a:not([class*="lively-link-preview"]),' +
        '.lively-wiki-editor-container a:not([class*="lively-link-preview"]),' +
        '.lively-postcard-view-content a:not([class*="lively-link-preview"]),' +
        '.lively-postcard-editor-container a:not([class*="lively-link-preview"]){color:#E31361;}' +
        '.lively-wiki-view-content a:not([class*="lively-link-preview"]):visited,' +
        '.lively-wiki-editor-container a:not([class*="lively-link-preview"]):visited,' +
        '.lively-postcard-view-content a:not([class*="lively-link-preview"]):visited,' +
        '.lively-postcard-editor-container a:not([class*="lively-link-preview"]):visited{color:#E31361;}' +
        '.lively-wiki-view-content a:not([class*="lively-link-preview"]):hover,' +
        '.lively-wiki-editor-container a:not([class*="lively-link-preview"]):hover,' +
        '.lively-postcard-view-content a:not([class*="lively-link-preview"]):hover,' +
        '.lively-postcard-editor-container a:not([class*="lively-link-preview"]):hover{color:#b80f4f;}' +
        '.lively-attachment-loading{opacity:0.35;}' +
        '.lively-attachment-error{opacity:0.5;filter:grayscale(1);}' +
        // code_cell (runnable Python/Scheme cells): one shared stylesheet for the
        // live editor's NodeView and the read-only render -- see codeCellCss.
        codeCellCss() +
        // Media-forward ("Reddit-like") preview wrappers — see
        // buildPreviewSplit above. Used by PostCardView's opt-in previewMode.
        // -rest is unclamped (a card that grows to fit its content, like
        // ConstellationLounge's reel via _fitCardToContent, should show all
        // of it).
        '.lively-postcard-preview-lead{font-size:11px;color:#333;margin:2px 0 4px;}' +
        '.lively-postcard-preview-media{margin:2px 0 4px;}' +
        '.lively-postcard-preview-rest{font-size:11.5px;color:#333;}' +
        // Unfurled link-preview card (see hydrateLinkPreviews below) —
        // inserted as a block right after a "bare link" paragraph.
        '.lively-link-preview-card{display:flex;margin:6px 0;border:1px solid #ddd;border-radius:8px;' +
        'overflow:hidden;text-decoration:none;color:inherit;background:#fff;max-width:480px;}' +
        '.lively-link-preview-card:hover{border-color:#aaa;background:#fafafa;}' +
        '.lively-link-preview-card-image-wrap{flex:0 0 96px;background:#eee;}' +
        '.lively-link-preview-card-image-wrap img{display:block;width:96px;height:96px;object-fit:cover;}' +
        '.lively-link-preview-card-text{flex:1 1 auto;min-width:0;padding:8px 10px;overflow:hidden;}' +
        '.lively-link-preview-card-site{font-size:10.5px;color:#888;text-transform:uppercase;' +
        'letter-spacing:0.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '.lively-link-preview-card-title{font-size:12.5px;font-weight:600;color:#222;margin-top:2px;' +
        'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}' +
        '.lively-link-preview-card-desc{font-size:11.5px;color:#666;margin-top:2px;' +
        'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}' +
        // Playable embed variant (Spotify/YouTube/SoundCloud/Apple Music/
        // Instagram) — a plain div, not an <a>, since an <iframe> is
        // interactive content and HTML forbids nesting that inside an
        // anchor. buildLinkPreviewCard picks block vs. inline height per
        // provider via a data attribute.
        '.lively-link-preview-embed{display:block;margin:6px 0;max-width:480px;}' +
        '.lively-link-preview-embed iframe{display:block;width:100%;border:0;border-radius:8px;}' +
        '.lively-link-preview-embed[data-embed-shape="video"] iframe{aspect-ratio:16/9;height:auto;}' +
        '.lively-link-preview-embed[data-embed-shape="audio"] iframe{height:152px;}' +
        // Reddit's embed.reddit.com post page ALSO has no fixed aspect ratio
        // (text posts vs. image/carousel posts vs. long comment counts all
        // render very different heights) -- the same shape of problem
        // Instagram's embed has, below -- but confirmed live it never sends
        // Instagram's resize postMessage (listened for 9s, nothing), and
        // neither does Reddit's OWN official widgets.js embed snippet
        // (tested directly against the real <blockquote>+<script> markup
        // their "Embed" button generates -- it just statically applies
        // whatever height the page author declares up front, same
        // limitation this file has). No oEmbed fallback either --
        // www.reddit.com/oembed is behind the same bot-wall as everything
        // else (see LinkPreviewServer.js's header comment). So there is no
        // real content height available to grow to, from any angle, ever --
        // reuses Instagram's "generous iframe + scrolling wrapper" trick
        // anyway (styleable pink scrollbar > Reddit's own unstyleable one),
        // with a STATIC iframe height standing in for a measured one.
        // BUG FIX (caught live): this was originally a much more generous
        // 1200px/600px split, sized to comfortably fit the one image-heavy
        // post this feature launched with -- but confirmed live across
        // several real posts of different kinds (sampled directly via
        // embed.reddit.com, not guessed): a plain text post is only
        // ~240-320px (Reddit's own embed clamps body text behind a "Read
        // more" toggle, so even a long post never renders tall), a single-
        // or multi-image post is ~715-740px, and a linked video is ~530px.
        // 1200px left most real posts (anything but an image) scrollable
        // down into several hundred px of true dead space below their real
        // content -- exactly the "empty scroll space" this now fixes.
        // 780px (a small margin over the ~740px image-post ceiling actually
        // observed) covers every sampled case with no clipping -- kept at
        // the generous end deliberately, since clipping loses real content
        // permanently (scrolling="no" means content past the iframe's own
        // box, not just past the visible window, is genuinely unreachable)
        // while a bit of blank space is only a cosmetic annoyance; there's
        // no way to rule out an even longer real post without the
        // measurement signal Reddit doesn't provide, so the ceiling stays
        // on the safe side. The VISIBLE window is the one actually tuned
        // for the common case instead: 320px, tight enough that a text post
        // (~240-320px real) shows with ~0-80px of slack rather than
        // hundreds, at the cost of needing a bit more scrolling than a
        // taller window would for video (~530px) and image (~715-740px)
        // posts -- never clipping either, just more of a "preview, scroll
        // for the rest" card for those two.
        // BUG FIX (caught live): overflow-y:auto on the wrapper below
        // reserves a real ~10-11px gutter for the scrollbar, shrinking the
        // iframe's own 100% width to fit beside it -- confirmed live via
        // getBoundingClientRect (iframe right edge landed at 500.7px vs. the
        // wrapper's 511.3px). Reddit's own content (a blurred-backdrop fill
        // behind the actual post image, not something this file renders)
        // then ends abruptly at that shrunk edge, well short of the card's
        // real border, with the scrollbar's gutter as a visibly different-
        // colored strip beyond it -- reads as two separate cards side by
        // side rather than one card with a scrollbar. Fix: let the iframe
        // overlap that gutter instead of yielding to it -- width wider than
        // the shrunk 100% by the scrollbar's own declared width, pulled back
        // with an equal negative right margin so its content still ends
        // exactly at the wrapper's true (unshrunk) right edge. The pink
        // thumb then draws on top of the iframe's own content as a real
        // overlay, same visual result as a native overlay scrollbar, without
        // relying on the overflow:overlay CSS value (removed from Chromium).
        '.lively-link-preview-embed[data-embed-shape="reddit"] iframe{height:780px;width:calc(100% + 10px);margin-right:-10px;}' +
        '.lively-link-preview-embed[data-embed-shape="reddit"]{max-height:320px;overflow-y:auto;}' +
        '.lively-link-preview-embed[data-embed-shape="reddit"]::-webkit-scrollbar{width:10px;}' +
        '.lively-link-preview-embed[data-embed-shape="reddit"]::-webkit-scrollbar-track{background:transparent;}' +
        '.lively-link-preview-embed[data-embed-shape="reddit"]::-webkit-scrollbar-thumb' +
        '{background:#f7c6d9;border-radius:6px;}' +
        '.lively-link-preview-embed[data-embed-shape="reddit"]{scrollbar-width:thin;scrollbar-color:#f7c6d9 transparent;}' +
        // Twitter's embed (platform.twitter.com/embed/Tweet.html, see
        // LinkPreviewServer.js's detectEmbed) has the exact same shape of
        // problem as Reddit just above: no fixed aspect ratio (text-only vs.
        // media-heavy tweets render very different heights) and, confirmed
        // live (listened for 4s after load), no resize postMessage the way
        // Instagram's embed sends — so this reuses Reddit's "generous static
        // iframe height + scrollable, pink-scrollbar wrapper" treatment
        // rather than Instagram's resize-driven one. Heights were measured
        // live, not guessed: a short text-only tweet ("just setting up my
        // twttr") rendered ~330px, a longer tweet with a 4-image grid
        // rendered ~470px. 900px covers real headroom beyond both samples
        // (a single large portrait image or a long multi-paragraph tweet
        // wasn't sampled, so this stays on the generous side for the same
        // reason Reddit's own height comment does — clipping loses real
        // content permanently, a bit of blank space doesn't). 460px for the
        // visible window shows the richer sampled tweet (~470px) almost
        // fully with barely any scroll, while a short text tweet (~330px)
        // just shows with some slack, same tradeoff Reddit's own window
        // sizing makes.
        '.lively-link-preview-embed[data-embed-shape="twitter"] iframe{height:900px;width:calc(100% + 10px);margin-right:-10px;}' +
        '.lively-link-preview-embed[data-embed-shape="twitter"]{max-height:460px;overflow-y:auto;}' +
        '.lively-link-preview-embed[data-embed-shape="twitter"]::-webkit-scrollbar{width:10px;}' +
        '.lively-link-preview-embed[data-embed-shape="twitter"]::-webkit-scrollbar-track{background:transparent;}' +
        '.lively-link-preview-embed[data-embed-shape="twitter"]::-webkit-scrollbar-thumb' +
        '{background:#f7c6d9;border-radius:6px;}' +
        '.lively-link-preview-embed[data-embed-shape="twitter"]{scrollbar-width:thin;scrollbar-color:#f7c6d9 transparent;}' +
        // Opaque patch over Twitter's own brand-logo link in the embed's
        // header (top-right corner) -- see _buildLinkPreviewEmbed's comment
        // on the cover element itself for the live-measured numbers this
        // box is based on and why a cover (not real removal) is the only
        // option for cross-origin iframe content. position:relative on the
        // wrap makes it the cover's containing block; since the cover is a
        // normal child of the SAME element that scrolls (the wrap itself,
        // per the overflow-y:auto rule above), it scrolls together with the
        // iframe rather than staying pinned mid-content.
        '.lively-link-preview-embed[data-embed-shape="twitter"]{position:relative;}' +
        // Flush against the card's own top-right corner (matching its
        // border-top-right-radius so the patch's own corner follows the
        // same curve rather than sticking out as a sharp square nub) and
        // sized generously -- 60x60, vs. the logo's own live-measured
        // ~28px glyph -- after a first, tighter attempt (44x44, inset from
        // the edges) still left a sliver of one of the X's diagonal strokes
        // poking out past its bottom-left corner, confirmed live via a
        // cropped screenshot of the rendered iframe.
        '.lively-link-preview-embed-twitter-cover{position:absolute;top:0;right:0;width:60px;height:60px;' +
        'background:#fff;border-top-right-radius:8px;pointer-events:none;}' +
        // Instagram's own /embed/captioned/ page has no fixed aspect ratio
        // across square/portrait/landscape posts, so instead of a fixed-
        // height iframe with ITS OWN internal (unstyleable — cross-origin)
        // scrollbar, _wireInstagramEmbedResize below grows the iframe to its
        // real content height (via a postMessage Instagram's embed page
        // sends unprompted) and this wrapper does the scrolling instead, in
        // a same-origin element we can actually style — confirmed live this
        // removes Instagram's own internal scrollbar entirely. 500px is just
        // the pre-resize fallback (avoids a zero-height flash before the
        // first postMessage arrives); the real cap is max-height below.
        '.lively-link-preview-embed[data-embed-shape="instagram"] iframe{height:500px;}' +
        '.lively-link-preview-embed[data-embed-shape="instagram"]{max-height:700px;overflow-y:auto;}' +
        '.lively-link-preview-embed[data-embed-shape="instagram"]::-webkit-scrollbar{width:10px;}' +
        '.lively-link-preview-embed[data-embed-shape="instagram"]::-webkit-scrollbar-track{background:transparent;}' +
        '.lively-link-preview-embed[data-embed-shape="instagram"]::-webkit-scrollbar-thumb' +
        '{background:#f7c6d9;border-radius:6px;}' +
        '.lively-link-preview-embed[data-embed-shape="instagram"]{scrollbar-width:thin;scrollbar-color:#f7c6d9 transparent;}' +
        // Bluesky post card — overrides the generic card's horizontal flex
        // layout (image-left/text-right) with a vertical stack, since this
        // is self-rendered post content, not a link-with-thumbnail.
        '.lively-link-preview-bluesky{display:block;padding:10px 12px;}' +
        '.lively-bsky-header{display:flex;align-items:center;gap:8px;}' +
        '.lively-bsky-avatar{width:32px;height:32px;border-radius:50%;object-fit:cover;flex:0 0 auto;}' +
        '.lively-bsky-authorblock{min-width:0;overflow:hidden;}' +
        '.lively-bsky-displayname{font-size:12.5px;font-weight:600;color:#222;white-space:nowrap;' +
        'overflow:hidden;text-overflow:ellipsis;}' +
        '.lively-bsky-handle{font-size:11px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '.lively-bsky-text{font-size:12.5px;color:#333;margin-top:6px;white-space:pre-wrap;' +
        'overflow-wrap:break-word;}' +
        '.lively-bsky-images{display:grid;gap:3px;margin-top:8px;border-radius:8px;overflow:hidden;}' +
        '.lively-bsky-images[data-count="1"]{grid-template-columns:1fr;}' +
        '.lively-bsky-images[data-count="2"]{grid-template-columns:1fr 1fr;}' +
        '.lively-bsky-images[data-count="3"],.lively-bsky-images[data-count="4"]{grid-template-columns:1fr 1fr;}' +
        '.lively-bsky-images img{display:block;width:100%;height:140px;object-fit:cover;background:#eee;}' +
        '.lively-bsky-stats{display:flex;gap:14px;margin-top:8px;font-size:11px;color:#888;}' +
        '.lively-bsky-stats span{display:inline-flex;align-items:center;gap:3px;}' +
        '.lively-bsky-stats .material-symbols-rounded{font-size:14px;}' +
        // Checklists (check_list > list_item[data-checked]): the box is a
        // Material Symbols glyph in ::before, not a real <input>, so the
        // same markup renders in the editor, read views and server HTML.
        'ul[data-type=checklist]{list-style:none;padding-left:4px;}' +
        'ul[data-type=checklist]>li{position:relative;padding-left:28px;}' +
        'ul[data-type=checklist]>li::before{content:"check_box_outline_blank";' +
        'font-family:"Material Symbols Rounded";font-size:20px;line-height:1.3;color:#999;' +
        'position:absolute;left:0;top:0;cursor:pointer;user-select:none;}' +
        'ul[data-type=checklist]>li[data-checked=true]::before{content:"check_box";color:#E31361;}' +
        'ul[data-type=checklist]>li[data-checked=true]>p:first-child{text-decoration:line-through;color:#888;}';
      document.head.appendChild(styleEl);
    }

    // Photo viewer. imgs: the <img> elements of one card, in order (their
    // current src — a decrypted blob: URL for a private photo — is read at
    // open time, so it works for every attachment kind); index: which one to
    // open. Two modes:
    //   - opts.container (an element): opens *inside* that element (the card),
    //     covering it, with an icon button that switches to the full-screen mode.
    //   - no container: full-screen, appended to document.body (not into a
    //     morph's DOM — see CLAUDE.md on overlays) so it sits above the whole
    //     world.
    // Both: X / click outside the photo / Escape closes, arrows / Left-Right
    // keys step through the card's other photos.
    var _fullscreenViewerOpen = false;

    function openImageViewer(imgs, index, opts) {
      if (!imgs || !imgs.length || typeof document === 'undefined') return;
      var container = opts && opts.container;
      var i = Math.max(0, index || 0);
      var overlay = document.createElement('div');
      overlay.style.cssText = container
        ? 'position:absolute;inset:0;z-index:20;background:#111;display:flex;align-items:center;justify-content:center;'
        : 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.9);display:flex;align-items:center;justify-content:center;';
      var full = document.createElement('img');
      full.style.cssText = (container
        ? 'max-width:100%;max-height:100%;'
        : 'max-width:96vw;max-height:94vh;box-shadow:0 4px 40px rgba(0,0,0,0.6);') +
        'object-fit:contain;border-radius:4px;';
      overlay.appendChild(full);

      // Icon buttons use the vendored Material Symbols font (ligature names).
      function btn(icon, css, title) {
        var b = document.createElement('button');
        b.textContent = icon;
        b.title = title;
        b.style.cssText = 'position:absolute;width:36px;height:36px;padding:0;border:none;border-radius:18px;' +
          "background:rgba(255,255,255,0.18);color:#fff;font-family:'Material Symbols Rounded';font-size:22px;" +
          'line-height:36px;cursor:pointer;' + css;
        overlay.appendChild(b);
        return b;
      }
      var closeBtn = btn('close', 'top:10px;right:10px;', 'Close (Esc)');
      var fsBtn = container ? btn('fullscreen', 'top:10px;right:54px;', 'Full screen') : null;
      var prevBtn = imgs.length > 1 ? btn('chevron_left', 'left:10px;top:50%;margin-top:-18px;', 'Previous') : null;
      var nextBtn = imgs.length > 1 ? btn('chevron_right', 'right:10px;top:50%;margin-top:-18px;', 'Next') : null;

      function show(n) {
        i = (n + imgs.length) % imgs.length;
        full.src = imgs[i].src;
        full.alt = imgs[i].alt || '';
      }
      function close() {
        document.removeEventListener('keydown', onKey, true);
        if (!container) _fullscreenViewerOpen = false;
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }
      function onKey(e) {
        // A full-screen viewer opened from this in-card one owns the keys.
        if (container && _fullscreenViewerOpen) return;
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowLeft' && imgs.length > 1) show(i - 1);
        else if (e.key === 'ArrowRight' && imgs.length > 1) show(i + 1);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }
      overlay.addEventListener('click', function (e) {
        e.stopPropagation();
        if (e.target === closeBtn || e.target === overlay) close();
        else if (e.target === prevBtn) show(i - 1);
        else if (e.target === nextBtn) show(i + 1);
        else if (e.target === fsBtn) openImageViewer(imgs, i);
      });
      // Keep Lively's own mouse/key handlers (registered on the window) from
      // seeing events aimed at the viewer.
      ['mousedown', 'mouseup', 'mousemove', 'keyup', 'keypress'].forEach(function (t) {
        overlay.addEventListener(t, function (e) { e.stopPropagation(); });
      });
      document.addEventListener('keydown', onKey, true);
      show(i);
      if (container) {
        container.appendChild(overlay);
      } else {
        _fullscreenViewerOpen = true;
        document.body.appendChild(overlay);
      }
    }

    // opts.feedMode: thread through to blocksToHtml's opts.suppressEmbeds —
    // for a condensed multi-row context rendering many snapshots at once
    // (ConstellationLounge.js's reply list) where a
    // persisted link_preview_card node should render as a plain text link,
    // never a card/iframe. Omit for a single full-card/page render (the
    // common case), where the real card/embed is exactly what should show.
    // opts.suppressEmbeds, when explicitly set (true or false), overrides
    // the feedMode-derived default -- lets a caller that wants feedMode's
    // other behavior (PostCardView.js's reel, via buildPreviewSplit) opt
    // back into real cards/embeds without reimplementing the split.
    function snapshotToHtml(snapshot, opts) {
      if (!snapshot || !snapshot.content) return '';
      var suppress = (opts && opts.suppressEmbeds !== undefined) ? opts.suppressEmbeds : !!(opts && opts.feedMode);
      return blocksToHtml(snapshot.content, suppress ? { suppressEmbeds: true } : undefined);
    }

    // A paragraph holding nothing but images (and blank text) is a photo row.
    // Consecutive photo rows merge into one gallery, chunked 4 at a time so
    // each gallery fits one of the 1/2/3/4 layouts.
    function imageOnlyParagraph(node) {
      if (!node || node.type !== 'paragraph' || !node.content || !node.content.length) return null;
      var imgs = [];
      for (var i = 0; i < node.content.length; i++) {
        var c = node.content[i];
        if (c.type === 'image') imgs.push(c);
        else if (c.type === 'text' && !/\S/.test(c.text || '')) continue;
        else return null;
      }
      return imgs.length ? imgs : null;
    }

    // opts.suppressEmbeds: render a link_preview_card node as a plain text
    // link, never a card/iframe (see pmNodeToHtml's 'link_preview_card'
    // case) — set by buildPreviewSplit's feedMode for condensed-row
    // contexts, matching hydrateLinkPreviews's own long-standing "no
    // preview card per row — noisy and expensive" posture (this file's
    // comment on MAX_LINK_PREVIEWS_PER_CONTAINER), now also covering the
    // persisted-node render path that posture didn't originally anticipate.
    // Threaded as a module-level flag rather than a second argument to
    // pmNodeToHtml (and every one of its recursive .map(pmNodeToHtml)
    // call sites) since this is synchronous, non-reentrant top-to-bottom
    // recursion — no risk of one caller's flag leaking into an unrelated
    // concurrent call.
    var _suppressEmbeds = false;

    function blocksToHtml(nodes, opts) {
      var prevSuppress = _suppressEmbeds;
      if (opts && opts.suppressEmbeds) _suppressEmbeds = true;
      var out = '', pending = [];
      var lastCardUrl = null; // dedup: collapse adjacent link_preview_card
      // siblings sharing the same url -- the one residual symptom of the
      // rare two-collaborators-insert-at-once Yjs race (WikiEditor.js's
      // dedup claim-check narrows but can't fully close that window; see
      // PostCardEditor.js's _buildLinkPreviewPlugin). Cosmetic only, and
      // self-heals the moment anyone edits near the duplicate.
      function flush() {
        for (var i = 0; i < pending.length; i += 4) out += galleryHtml(pending.slice(i, i + 4));
        pending = [];
      }
      (nodes || []).forEach(function (node) {
        var imgs = imageOnlyParagraph(node);
        if (imgs) { pending = pending.concat(imgs); return; }
        flush();
        if (node.type === 'link_preview_card') {
          var url = (node.attrs && node.attrs.url) || '';
          if (url && url === lastCardUrl) return; // skip duplicate
          lastCardUrl = url;
        } else {
          lastCardUrl = null;
        }
        out += pmNodeToHtml(node);
      });
      flush();
      _suppressEmbeds = prevSuppress;
      return out;
    }

    function galleryHtml(imgs) {
      return '<div class="lively-media-grid lively-media-n' + imgs.length + '">' +
        imgs.map(function (img) {
          return '<div class="lively-media-cell">' + imageTagHtml(img, '', false) + '</div>';
        }).join('') + '</div>';
    }

    // Recursively concatenates plain text out of a ProseMirror node tree —
    // deeper than PostCardSerializer.js's private _extractFirstBlockText
    // (which only looks one level down), needed here because "the rest of
    // the body" in a preview can include list_item/blockquote-wrapped
    // paragraphs, not just a single top-level one.
    function _plainTextOfNode(node) {
      if (!node) return '';
      if (node.type === 'text') return node.text || '';
      if (!node.content) return '';
      return node.content.map(_plainTextOfNode).join(' ');
    }

    // buildPreviewSplit(docContent, opts) — walks a ProseMirror doc's
    // top-level block array (the same shape blocksToHtml/snapshotToHtml
    // already consume) and splits it into a short leading text excerpt, the
    // first media block (promoted to appear early even if it means cutting
    // remaining pre-media text — media always shows if the doc has any),
    // and whatever comes after. Used by PostCardView's opt-in preview mode
    // (ConstellationLounge's reel) to
    // build a "Reddit-like" media-forward preview instead of showing
    // content in plain document order. Reuses blocksToHtml/
    // imageOnlyParagraph for actual HTML generation — no second renderer,
    // no duplicated per-node-type logic (image/video/gallery/attachment-
    // placeholder rendering all come along for free).
    //
    // opts.leadBudget (default 140): char budget for the lead excerpt.
    // opts.restBudget (default 400): char budget for the "rest" segment,
    // enforced at whole-block granularity only (never a mid-block string
    // cut, which could produce broken HTML) — a single verbose trailing
    // block can run a bit over this; callers that need a hard visual cap
    // (e.g. a fixed-max-height row) apply their own CSS
    // clamp/fade on top of this.
    //
    // Returns { hasMedia, leadExcerpt, mediaHtml, restHtml, restTruncated }.
    // hasMedia:false means the doc has no image/video content at all —
    // callers should ignore leadExcerpt/mediaHtml/restHtml entirely and
    // fall back to their own plain/unsplit rendering in that case.
    //
    // opts.feedMode: condensed-row context — suppresses
    // link-preview cards/iframes in mediaHtml/restHtml (see blocksToHtml's
    // opts.suppressEmbeds), same posture as this file's existing "no card in
    // a condensed row" rule for hydrateLinkPreviews. opts.suppressEmbeds,
    // when explicitly set, overrides the feedMode-derived default — lets a
    // caller keep the media-forward split (PostCardView.js's reel) without
    // also suppressing link-preview cards/embeds.
    function buildPreviewSplit(docContent, opts) {
      opts = opts || {};
      var leadBudget = opts.leadBudget || 140;
      var restBudget = opts.restBudget || 400;
      var suppressEmbeds = opts.suppressEmbeds !== undefined ? opts.suppressEmbeds : !!opts.feedMode;
      var blocksOpts = suppressEmbeds ? { suppressEmbeds: true } : undefined;
      var nodes = docContent || [];

      var leadPlain = '';
      var mediaNodes = [];
      var hasMedia = false;
      var i = 0;

      for (; i < nodes.length; i++) {
        var node = nodes[i];
        var imgs = imageOnlyParagraph(node);
        var isBareMedia = !imgs && node && (node.type === 'image' || node.type === 'video' || node.type === 'audio');
        if (imgs || isBareMedia) {
          hasMedia = true;
          if (imgs) {
            // Merge the maximal *consecutive* run of image-only paragraphs,
            // mirroring blocksToHtml's own pending/flush merge exactly (so
            // the eventual render goes through the same 4-per-gallery
            // chunking via galleryHtml).
            while (i < nodes.length && imageOnlyParagraph(nodes[i])) { mediaNodes.push(nodes[i]); i++; }
          } else {
            // A bare top-level image/video/audio node — blocksToHtml never
            // merges these with neighbors either, so neither do we.
            mediaNodes.push(node);
            i++;
          }
          break;
        }
        // Once leadBudget is exceeded we keep *scanning* for media (per the
        // "media always gets promoted" rule) — we just stop *appending* to
        // leadPlain, via this guard.
        if (leadPlain.length < leadBudget) {
          var text = _plainTextOfNode(node);
          if (text) leadPlain += (leadPlain ? ' ' : '') + text;
        }
      }

      // "Rest" is whatever whole blocks come after the media run, capped by
      // restBudget at block granularity only.
      var restNodes = [];
      var restPlainLen = 0;
      var restTruncated = false;
      for (; i < nodes.length; i++) {
        var rNode = nodes[i];
        var rLen = _plainTextOfNode(rNode).length;
        if (restNodes.length > 0 && restPlainLen + rLen > restBudget) {
          restTruncated = true;
          break;
        }
        restNodes.push(rNode);
        restPlainLen += rLen;
        if (restPlainLen > restBudget) {
          restTruncated = (i + 1 < nodes.length);
          break;
        }
      }

      return {
        hasMedia: hasMedia,
        leadExcerpt: excerptText(leadPlain, leadBudget),
        mediaHtml: hasMedia ? blocksToHtml(mediaNodes, blocksOpts) : '',
        restHtml: blocksToHtml(restNodes, blocksOpts),
        restTruncated: restTruncated,
      };
    }

    function imageTagHtml(node, extraClass, decorative) {
      var src = (node.attrs && node.attrs.src) || '';
      var alt = decorative ? '' : ((node.attrs && node.attrs.alt) || '');
      var imgTitle = !decorative && node.attrs && node.attrs.title;
      var deco = decorative ? ' aria-hidden="true"' : '';
      if (!src && node.attrs && node.attrs.objId) {
        return '<img class="lively-postcard-image' + extraClass + attachmentPlaceholderClass() + '"' +
               attachmentPlaceholderAttrs(node) + ' alt="' + escapeAttr(alt) + '"' + deco + '>';
      }
      return '<img class="lively-postcard-image' + extraClass + '" src="' + escapeAttr(src) + '" alt="' + escapeAttr(alt) + '"' +
             (imgTitle ? ' title="' + escapeAttr(imgTitle) + '"' : '') + deco + '>';
    }

    // BUG FIX: no read-only view (PostCardView, WikiView,
    // WikiHistory) ever turned a rendered .lively-embedded-part placeholder
    // into the actual live Lively morph it references — confirmed live, the
    // placeholder text is permanent, not just a brief loading state. The
    // live editor's NodeView (_embeddedPartNodeView in PostCardEditor.js/
    // WikiEditor.js) already has this exact fetch-envelope+loadPart logic;
    // this is the same thing, standalone (no ProseMirror view/getPos to
    // thread through, no selection overlay). Callers: after setting
    // .innerHTML from snapshotToHtml(...), call
    // hydrateEmbeddedParts(thatContainerEl) to upgrade every placeholder
    // inside it in place.
    function hydrateEmbeddedParts(containerEl) {
      if (!containerEl || typeof document === 'undefined') return;
      var placeholders = containerEl.querySelectorAll('.lively-embedded-part[data-obj-id]');
      Array.prototype.forEach.call(placeholders, _hydrateOneEmbeddedPart);
    }

    function _hydrateOneEmbeddedPart(el) {
      var handle = el.getAttribute('data-handle');
      var objId = el.getAttribute('data-obj-id');
      var cid = el.getAttribute('data-cid');
      // No data-handle: a pre-fix embed saved before this attr existed, or a
      // malformed one. Nothing to fetch from — leave the placeholder text.
      if (!handle || !objId) return;
      if (typeof lively === 'undefined' || !lively.require) return;

      function showError(msg) {
        el.textContent = msg;
        el.classList.add('lively-embed-error');
      }

      lively.require('lively.identity.IdentityPartsSpace').toRun(function () {
        var base = lively.identity.did.baseUrl();
        var url = base + '/@' + encodeURIComponent(handle) + '/' + encodeURIComponent(objId) +
          (cid ? ('/at/' + encodeURIComponent(cid)) : '');
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status === 404) { showError(cid ? 'This part was removed.' : 'Part not found.'); return; }
          if (xhr.status !== 200) { showError('Failed to load part: HTTP ' + xhr.status); return; }
          var envelope;
          try { envelope = JSON.parse(xhr.responseText); } catch (e) { showError('Invalid part data'); return; }
          if (envelope.type !== 'part' || !envelope.record) { showError('Not a part envelope'); return; }
          var space = new lively.identity.IdentityPartsSpace(handle, null);
          var item = space.createPartItemFromEnvelope(envelope);
          if (!item) { showError('Missing partName in embedded object'); return; }
          item.loadPart(false, false, envelope.record.cid, function (err, part) {
            if (err || !part) {
              showError('Could not render part: ' + ((err && err.message) || 'unknown error'));
              return;
            }
            el.innerHTML = '';
            var partDom = part.renderContext && part.renderContext().shapeNode;
            if (partDom) el.appendChild(partDom);
            else { showError('Part has no renderable content'); return; }
            // BUG FIX: same clipping issue as the editor's NodeView (see its
            // matching fix in PostCardEditor.js/WikiEditor.js) — a Lively
            // morph's shapeNode is position:absolute and never grows el's
            // flow height, so el stayed at its ~32px min-height regardless
            // of the morph's real size.
            if (part.getExtent) {
              var partExtent = part.getExtent();
              el.style.width = partExtent.x + 'px';
              el.style.height = partExtent.y + 'px';
            }
          });
        };
        xhr.onerror = function () { showError('Network error loading part'); };
        xhr.send();
      });
    }

    // Post-processes rendered HTML from snapshotToHtml to resolve private/
    // shared attachment placeholders (img/video/audio with no src, emitted
    // by pmNodeToHtml when node.attrs.objId is set) into session-local
    // blob: URLs — the same decrypt-once-per-blobCid logic
    // PostCardEditor.js's NodeViews (_attachmentImageNodeView etc.) already
    // use live in the editor. attachments: array of
    // { objId, dek, blobCid, blobNonce, name, mime } — payload.attachments
    // from deserializeEncryptedAuto (dek/blobNonce absent for a public
    // attachment, present for private/shared). Call after
    // hydrateEmbeddedParts, once per decrypt-in-place render.
    function hydrateAttachments(containerEl, handle, attachments) {
      if (!containerEl || typeof document === 'undefined') return;
      var placeholders = containerEl.querySelectorAll('.lively-attachment-placeholder[data-obj-id]');
      Array.prototype.forEach.call(placeholders, function (el) {
        _hydrateOneAttachment(el, handle, attachments || []);
      });
    }

    function _hydrateOneAttachment(el, handle, attachments) {
      var objId = el.getAttribute('data-obj-id');
      if (!objId) return;
      if (typeof lively === 'undefined' || !lively.require) return;

      function showError() {
        el.classList.remove('lively-attachment-loading');
        el.classList.add('lively-attachment-error');
      }

      var entry = attachments.filter(function (a) { return a.objId === objId; })[0];
      if (!entry) { showError(); return; }

      lively.require('lively.identity.FileCrypto').toRun(function () {
        lively.identity.fileCrypto.resolveAttachmentUrl(handle, entry, function (err, url) {
          if (err) { showError(); return; }
          el.classList.remove('lively-attachment-loading');
          el.src = url; // valid IDL attribute for img/video/audio alike
        });
      });
    }

    // Wires up every code_cell placeholder's Run button in a read-only
    // render (WikiView/WikiHistory/WikiEditor's own Preview mode -- see
    // WikiEditor._togglePreview) to the same runCodeCell/stopCodeCell
    // orchestration the live editor's NodeView uses. The read-only source
    // is inert text -- Run just executes whatever static source is already
    // embedded in the HTML; there is nothing to edit here.
    function hydrateCodeCells(containerEl) {
      if (!containerEl || typeof document === 'undefined') return;
      var buttons = containerEl.querySelectorAll('.lively-code-cell-run-btn[data-hydrate="code-cell"]');
      Array.prototype.forEach.call(buttons, _hydrateOneCodeCell);
    }

    function _hydrateOneCodeCell(runBtn) {
      var cellEl = runBtn.closest ? runBtn.closest('.lively-code-cell') : null;
      if (!cellEl) return;
      var sourceEl = cellEl.querySelector('pre.lively-code-cell-source');
      var outputEl = cellEl.querySelector('.lively-code-cell-output');
      var statusEl = cellEl.querySelector('.lively-code-cell-status');
      var stopBtn = cellEl.querySelector('.lively-code-cell-stop-btn');
      if (!sourceEl || !outputEl) return;

      var def = codeCellLanguage(cellEl.getAttribute('data-language'));
      if (!def.known) return;
      var language = def.id;
      var resetBtn = cellEl.querySelector('.lively-code-cell-reset-btn');

      function setRunning(isRunning, statusText) {
        runBtn.style.display = isRunning ? 'none' : '';
        if (stopBtn) stopBtn.style.display = isRunning ? 'inline-block' : 'none';  // '' would fall back to the stylesheet's display:none
        if (resetBtn) resetBtn.style.display = isRunning ? 'none' : '';
        if (statusEl) statusEl.textContent = statusText;
      }

      if (def.output === 'transcript') {
        var transcriptOut = createSchemeOutput(outputEl);
        var STATE_LABEL = { done: 'Ran just now', error: 'Error', stopped: 'Stopped', exit: 'Exited' };
        runBtn.addEventListener('click', function () {
          transcriptOut.start();
          runCodeCell(sourceEl.textContent, {
            onStatus: function (text) { setRunning(true, text); },
            onSegments: function (segments) { transcriptOut.append(segments); },
            onDraw: function (ops, turtle) { transcriptOut.draw(ops, turtle); },
            onNeedInput: function () {
              setRunning(true, 'Waiting for input…');
              transcriptOut.showInput(function (text) { setRunning(true, 'Running…'); provideCodeCellInput(text, language); });
            },
            onDone: function (err, result) {
              var state = result && result.state;
              setRunning(false, err ? 'Error' : (STATE_LABEL[state] || 'Ran just now'));
              transcriptOut.finish(state, err);
            },
          }, language);
        });
        if (stopBtn) {
          stopBtn.addEventListener('click', function () {
            if (stopCodeCell(language)) setRunning(true, 'Stopping…');
            else setRunning(false, 'Stopped');
          });
        }
        if (resetBtn) {
          resetBtn.addEventListener('click', function () {
            resetCodeCell(language, function () { setRunning(false, 'Environment reset'); });
          });
        }
        return;
      }

      function renderOutput(response, err) {
        outputEl.innerHTML = '';
        outputEl.classList.remove('lively-code-cell-output-empty');
        var hasContent = false;
        if (response && response.stdout) {
          var stdoutPre = document.createElement('pre');
          stdoutPre.textContent = response.stdout;
          outputEl.appendChild(stdoutPre);
          hasContent = true;
        }
        (response && response.images || []).forEach(function (b64) {
          var img = document.createElement('img');
          img.src = 'data:image/png;base64,' + b64;
          outputEl.appendChild(img);
          hasContent = true;
        });
        if (response && response.result != null) {
          var resultPre = document.createElement('pre');
          resultPre.textContent = response.result;
          outputEl.appendChild(resultPre);
          hasContent = true;
        }
        if (response && response.stderr) {
          var stderrPre = document.createElement('pre');
          stderrPre.className = 'lively-code-cell-stderr';
          stderrPre.textContent = response.stderr;
          outputEl.appendChild(stderrPre);
          hasContent = true;
        }
        if (err) {
          var errPre = document.createElement('pre');
          errPre.className = 'lively-code-cell-stderr';
          errPre.textContent = err.message || String(err);
          outputEl.appendChild(errPre);
          hasContent = true;
        }
        if (!hasContent) {
          outputEl.classList.add('lively-code-cell-output-empty');
          outputEl.textContent = 'Ran with no output.';
        }
      }

      runBtn.addEventListener('click', function () {
        runCodeCell(sourceEl.textContent, {
          onStatus: function (text) { setRunning(true, text); },
          onDone: function (err, response) { setRunning(false, err ? 'Error' : 'Ran just now'); renderOutput(response, err); },
        }, language);
      });
      if (stopBtn) {
        stopBtn.addEventListener('click', function () { stopCodeCell(language); setRunning(false, 'Stopped'); });
      }
    }

    // ── Link previews ───────────────────────────────────────────────────
    // Scans a rendered container for "bare link" blocks — a <p>/<li> whose
    // ENTIRE content is one URL, either already a <a> (a link mark applied
    // over a selection, see PostCardEditor.js's _promptLink) or plain text
    // that looks like a URL (PostCardEditor.js/WikiEditor.js have no
    // autolink-on-paste input rule, so a pasted bare URL is otherwise inert
    // text — this both auto-linkifies it for display and treats it as an
    // unfurl candidate). Mirrors the common chat-app convention (Slack/
    // Discord/iMessage): a URL inline within a sentence stays a plain
    // hyperlink; a URL that IS its paragraph gets a title/description/image
    // card fetched through LinkPreviewServer.js and inserted right after
    // it. Call after hydrateEmbeddedParts/hydrateCodeCells, same "upgrade
    // in place" convention as those — containerEl must already be in the
    // document (card insertion is a plain DOM sibling-insert, no live-ness
    // requirement beyond that).
    //
    // Capped at MAX_LINK_PREVIEWS_PER_CONTAINER fetches per call so a long
    // document full of bare links can't fire off unbounded parallel
    // requests. Not called from WikiHistory.js's version viewer, which
    // renders many historical entries at once, where a preview card per row
    // would be noisy and expensive.
    var MAX_LINK_PREVIEWS_PER_CONTAINER = 6;
    var BARE_URL_RE = /^(https?:\/\/[^\s<>"']+)$/i;
    var _linkPreviewCache = {}; // url -> array of pending callbacks, or {done:true, err, body}

    function hydrateLinkPreviews(containerEl) {
      if (!containerEl || typeof document === 'undefined') return;
      var candidates = _findBareLinkBlocks(containerEl);
      candidates.slice(0, MAX_LINK_PREVIEWS_PER_CONTAINER).forEach(function (c) {
        _fetchLinkPreview(c.url, function (err, body) {
          if (err || !body || body.error) return; // silent — no card, no error UI
          _insertLinkPreviewCard(c.el, body);
        });
      });
    }

    // Upgrades any already-inserted Instagram embed card's iframe with the
    // same live auto-resize behavior _buildLinkPreviewEmbed wires up
    // directly for the live-DOM path (editor NodeViews, hydrateLinkPreviews'
    // own bare-link fallback above). Needed as a SEPARATE step here because
    // linkPreviewCardHtml (used by snapshotToHtml/pmNodeToHtml for every
    // read-only render — PostCardView, WikiView, WikiEditor's preview mode,
    // WikiHistory) emits plain inert markup via innerHTML, with no
    // NodeView-equivalent hook to attach JS behavior at insertion time. A
    // harmless no-op scan when containerEl has no Instagram embed in it —
    // call after setting containerEl.innerHTML, same convention as
    // hydrateEmbeddedParts/hydrateCodeCells/hydrateLinkPreviews.
    function hydrateLinkPreviewEmbeds(containerEl) {
      if (!containerEl || typeof document === 'undefined') return;
      var frames = containerEl.querySelectorAll('.lively-link-preview-embed[data-embed-shape="instagram"] iframe');
      Array.prototype.forEach.call(frames, function (iframe) {
        if (iframe._ligResizeWired) return;
        iframe._ligResizeWired = true;
        _wireInstagramEmbedResize(iframe);
      });
    }

    function _findBareLinkBlocks(containerEl) {
      var out = [];
      var seen = {};
      var blocks = containerEl.querySelectorAll('p, li');
      Array.prototype.forEach.call(blocks, function (block) {
        var url = _bareLinkUrlOf(block);
        if (!url || seen[url]) return;
        // A persisted link_preview_card node (schema's toDOM, or this
        // function's own _insertLinkPreviewCard below) already rendered as
        // the next sibling — this is legacy-content territory only (a bare
        // URL paragraph saved before the persisted-node change existed);
        // once a real card already sits here, don't insert a second,
        // separately-live-fetched one next to it.
        var next = block.nextElementSibling;
        if (next && next.classList && next.classList.contains('lively-link-preview-card')) return;
        seen[url] = true;
        out.push({ el: block, url: url });
      });
      return out;
    }

    // Returns the URL if `block`'s only meaningful content, once you strip
    // away any nesting of plain inline formatting wrappers (ignoring
    // whitespace-only text nodes at each level), is a single link or a
    // single bare-URL text run — else null. A plain-text URL match is
    // rewritten into a real <a> in place as a side effect, so it's
    // clickable even while/if the preview fetch is still pending or fails.
    //
    // The descent through INLINE_WRAPPER_TAGS matters for real content:
    // a URL pasted from a rich-text source (e.g. Google Docs) typically
    // arrives as a lone text node buried under several layers of
    // <span style="font-family:...">/<strong> wrappers rather than sitting
    // directly in the <p> — the single-level check this used to do missed
    // that shape entirely (silently skipped it, no card, no error) while a
    // plain-typed URL in the same document matched fine.
    var INLINE_WRAPPER_TAGS = { SPAN: 1, STRONG: 1, B: 1, EM: 1, I: 1, U: 1 };
    function _bareLinkUrlOf(block) {
      var node = block;
      for (;;) {
        var kids = Array.prototype.filter.call(node.childNodes, function (n) {
          return !(n.nodeType === 3 && !/\S/.test(n.textContent || ''));
        });
        if (kids.length !== 1) return null;
        var only = kids[0];
        if (only.nodeType === 1 && only.tagName === 'A') {
          var href = safeHref(only.getAttribute('href') || '');
          return /^https?:\/\//i.test(href) ? href : null;
        }
        if (only.nodeType === 3) {
          var text = (only.textContent || '').trim();
          var m = BARE_URL_RE.exec(text);
          if (!m) return null;
          var a = document.createElement('a');
          a.href = m[1];
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = m[1];
          node.replaceChild(a, only);
          return m[1];
        }
        if (only.nodeType === 1 && INLINE_WRAPPER_TAGS[only.tagName]) {
          node = only;
          continue;
        }
        return null;
      }
    }

    // Fetches (or reuses an in-flight/cached fetch of) url's preview
    // metadata. thenDo(err, body) — body.error set means "fetched fine, but
    // nothing worth showing" (e.g. a page with no OG tags at all), treated
    // the same as a network error by callers (no card). Exported (below) as
    // fetchLinkPreview — also used directly by PostCardEditor.js/
    // WikiEditor.js's live-editor decoration plugin (via peekLinkPreview,
    // next function), so a link previewed once while composing and once
    // more after the card is saved/viewed hits the same cache.
    function _fetchLinkPreview(url, thenDo) {
      var entry = _linkPreviewCache[url];
      if (entry && entry.done) return thenDo(entry.err, entry.body);
      if (entry) { entry.waiters.push(thenDo); return; }
      _linkPreviewCache[url] = { done: false, waiters: [thenDo] };

      var base = lively.identity.did.baseUrl();
      var xhr = new XMLHttpRequest();
      xhr.open('GET', base + '/nodejs/LinkPreviewServer/unfurl?url=' + encodeURIComponent(url));
      xhr.withCredentials = true;
      function finish(err, body) {
        var waiters = _linkPreviewCache[url].waiters;
        _linkPreviewCache[url] = { done: true, err: err, body: body };
        waiters.forEach(function (cb) { cb(err, body); });
      }
      xhr.onload = function () {
        var body = null;
        try { body = JSON.parse(xhr.responseText); } catch (e) {}
        finish((xhr.status === 200 || xhr.status === 422) ? null : new Error('HTTP ' + xhr.status), body);
      };
      xhr.onerror = function () { finish(new Error('Network error'), null); };
      xhr.send();
    }

    // Non-fetching read of the cache _fetchLinkPreview maintains: returns
    // undefined if url has never been requested (caller should kick off a
    // real fetchLinkPreview call), null while a fetch is in flight (ask
    // again later — e.g. once the caller's own refresh hook fires), or
    // { err, body } once settled. Lets a ProseMirror decorations() function
    // (which must be a pure, synchronous read of state — see
    // _buildLinkPreviewPlugin) check "is there something to render right
    // now" without ever itself triggering an XHR as a side effect.
    function peekLinkPreview(url) {
      var entry = _linkPreviewCache[url];
      if (!entry) return undefined;
      if (!entry.done) return null;
      return { err: entry.err, body: entry.body };
    }

    // Client-side re-validation allow-list for embedUrl's hostname — defense
    // in depth on top of LinkPreviewServer.js's own detectEmbed, which is
    // the one that actually decides provider/embedUrl (see that file's
    // header). Never render an <iframe src> whose hostname isn't exactly
    // one of these, even though the server should only ever send a
    // known-good one. "shape" picks the embed's aspect ratio (video, 16:9)
    // vs. fixed-height (audio) in the CSS above, and "label" is the
    // "Open in ..." text link shown alongside the iframe.
    var EMBED_HOSTS = {
      'open.spotify.com':     { label: 'Open in Spotify',     shape: 'audio' },
      'www.youtube.com':      { label: 'Open in YouTube',     shape: 'video' },
      'w.soundcloud.com':     { label: 'Open in SoundCloud',  shape: 'audio' },
      'embed.music.apple.com': { label: 'Open in Apple Music', shape: 'audio' },
      'www.instagram.com':    { label: 'Open in Instagram',   shape: 'instagram' },
      'embed.reddit.com':     { label: 'Open in Reddit',      shape: 'reddit' },
      'platform.twitter.com': { label: 'Open in Twitter',    shape: 'twitter' },
    };

    function _embedHostInfo(embedUrl) {
      try {
        var host = new URL(embedUrl).hostname.toLowerCase();
        return EMBED_HOSTS[host] || null;
      } catch (e) { return null; }
    }

    // data: { url, title, description, image, siteName, provider, embedUrl }
    // from LinkPreviewServer.js — all untrusted third-party strings, rendered
    // via textContent only (same rule as RssProxyServer's entries); `url`/
    // `image`/`embedUrl` go through safeHref/_embedHostInfo since the server
    // only allow-lists http(s) at the scheme level, not full trust. Shared by
    // _insertLinkPreviewCard (read-only renders), PostCardEditor.js/
    // WikiEditor.js's live-editor decoration widget AND their
    // _linkPreviewCardNodeView (the persisted-node render) — one card
    // builder, several insertion mechanisms.
    function buildLinkPreviewCard(data) {
      if (data.provider === 'bluesky' && data.bluesky) return _buildBlueskyCard(data);

      var embedInfo = data.embedUrl ? _embedHostInfo(data.embedUrl) : null;
      if (embedInfo) return _buildLinkPreviewEmbed(data, embedInfo);

      var card = document.createElement('a');
      card.className = 'lively-link-preview-card';
      card.href = safeHref(data.url);
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
      // Belongs in a contenteditable ProseMirror doc as inert chrome, not
      // editable/selectable text — harmless (and ignored) in the plain
      // read-only-render call sites.
      card.contentEditable = 'false';

      var safeImage = data.image ? safeHref(data.image) : null;
      if (safeImage && safeImage !== '#') {
        var imgWrap = document.createElement('div');
        imgWrap.className = 'lively-link-preview-card-image-wrap';
        var img = document.createElement('img');
        img.src = safeImage;
        img.alt = '';
        img.loading = 'lazy';
        // LinkPreviewServer.js's image field now has a fallback chain that
        // ends in an UNVERIFIED guessed "<origin>/favicon.ico" (not every
        // site actually has one there) -- hide the whole image slot rather
        // than show a broken-image icon when that guess 404s/errors.
        img.onerror = function () { imgWrap.remove(); };
        imgWrap.appendChild(img);
        card.appendChild(imgWrap);
      }

      var textWrap = document.createElement('div');
      textWrap.className = 'lively-link-preview-card-text';
      if (data.siteName) {
        var site = document.createElement('div');
        site.className = 'lively-link-preview-card-site';
        site.textContent = data.siteName;
        textWrap.appendChild(site);
      }
      if (data.title) {
        var title = document.createElement('div');
        title.className = 'lively-link-preview-card-title';
        title.textContent = data.title;
        textWrap.appendChild(title);
      }
      if (data.description) {
        var desc = document.createElement('div');
        desc.className = 'lively-link-preview-card-desc';
        desc.textContent = data.description;
        textWrap.appendChild(desc);
      }
      card.appendChild(textWrap);

      ['mousedown', 'click'].forEach(function (t) {
        card.addEventListener(t, function (e) { e.stopPropagation(); });
      });
      return card;
    }

    // Instagram's /embed/captioned/ page posts window.postMessage({type:
    // "MEASURE", details:{height}}) to its parent unprompted, as soon as it
    // mounts and whenever its content reflows -- confirmed live (not gated
    // on Instagram's own official embed.js being loaded in the parent; any
    // listening parent gets it). Used to size the iframe to its real content
    // height so Instagram's own internal scrollbar never appears, letting
    // the wrapper div's own (same-origin, styleable -- see the CSS above)
    // scrollbar take over instead. A cross-origin iframe's internal
    // scrollbar can't be restyled from the parent page at all, which is why
    // this resize dance exists rather than just a fixed-height iframe.
    function _wireInstagramEmbedResize(iframe) {
      function onMsg(e) {
        // Self-cleaning: once the card (and this iframe) is removed from the
        // document -- e.g. the editor rebuilds this NodeView, or the user
        // navigates away from this wiki version -- drop the listener rather
        // than leaking it for the rest of the page's lifetime.
        if (!iframe.isConnected) { window.removeEventListener('message', onMsg); return; }
        if (e.source !== iframe.contentWindow) return;
        var data = e.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e2) { return; } }
        if (!data || data.type !== 'MEASURE' || !data.details || typeof data.details.height !== 'number') return;
        iframe.style.height = data.details.height + 'px';
      }
      window.addEventListener('message', onMsg);
    }

    // Playable-embed variant — a plain div, never an <a> (HTML forbids
    // nesting an <iframe>, which is interactive content, inside an anchor).
    // sandbox intentionally omits allow-top-navigation/allow-forms; allow-
    // same-origin is needed for Spotify/YouTube/SoundCloud's own players to
    // read their own storage, allow-popups for "open in app" links some of
    // them show internally.
    function _buildLinkPreviewEmbed(data, embedInfo) {
      var wrap = document.createElement('div');
      wrap.className = 'lively-link-preview-card lively-link-preview-embed';
      wrap.setAttribute('data-embed-shape', embedInfo.shape);
      wrap.contentEditable = 'false';

      var iframe = document.createElement('iframe');
      iframe.src = data.embedUrl;
      iframe.loading = 'lazy';
      // BUG FIX (caught live testing the YouTube embed): matches each
      // provider's own documented embed snippet (YouTube's in particular)
      // rather than a guessed minimal set -- without allowfullscreen +
      // allow-presentation, the player's own fullscreen button silently
      // doesn't work (no error, it just does nothing). strict-origin-when-
      // cross-origin (the browser's own default) instead of no-referrer:
      // no-referrer wasn't actually the cause of a real "Error 153" hit
      // while testing (confirmed by removing it and still seeing the same
      // error -- that one turned out to be YouTube's own embed-origin
      // policy for a plain-http/localhost origin, unrelated to any
      // attribute here), but there's no reason to strip more than the
      // default, and matching each provider's own recommended snippet is
      // the safer default to start from.
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      iframe.sandbox = 'allow-scripts allow-same-origin allow-popups allow-presentation';
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen';
      iframe.setAttribute('allowfullscreen', '');
      iframe.title = data.title || embedInfo.label;
      if (embedInfo.shape === 'video') iframe.height = '270'; // overridden by aspect-ratio CSS once loaded
      if (embedInfo.shape === 'instagram') {
        _wireInstagramEmbedResize(iframe);
        // BUG FIX (caught live): resizing the iframe to its real content
        // height (above) stops ITS content from needing to scroll, but
        // Instagram's own page still forces a scrollbar gutter regardless
        // (common anti-layout-shift CSS, e.g. `overflow-y:scroll` on its own
        // html/body) -- confirmed live as a second, unstyleable gray classic
        // scrollbar (complete with arrow buttons) rendered right next to our
        // own pink one. The legacy `scrolling` attribute is enforced by the
        // browser at the frame level, overriding whatever the framed page's
        // own CSS wants, so it suppresses that regardless of origin.
        iframe.setAttribute('scrolling', 'no');
      }
      // Reddit (and Twitter, same static-height treatment — see its CSS
      // comment above) gets the same legacy-`scrolling` suppression as
      // Instagram above, for the same reason: an exceptionally long post
      // (taller than the static height guess) would otherwise show its OWN
      // internal scrollbar nested inside the wrapper's already-scrolling
      // pink one. Content past that static height becomes unreachable
      // either way — see that CSS comment — this just avoids a double
      // scrollbar for it.
      if (embedInfo.shape === 'reddit' || embedInfo.shape === 'twitter') iframe.setAttribute('scrolling', 'no');
      wrap.appendChild(iframe);

      // Twitter's embed draws its own small brand-logo link (top-right of
      // the header row, "Visit this post on X") that isn't user content.
      // There's no query param on platform.twitter.com/embed/Tweet.html to
      // suppress it (unlike Instagram/Reddit's embeds, which have no
      // equivalent mark at all), and it's cross-origin content this file
      // can't reach with CSS/JS -- so this covers it with a plain opaque
      // patch matching the embed's own white background instead of
      // removing it. Sized/positioned generously (flush with the card's
      // own top-right corner, 60x60 vs. the glyph's own live-measured
      // ~28px) rather than tightly around the live-measured glyph itself —
      // see this shape's CSS comment for why a tighter first attempt still
      // left a visible sliver. Well clear of the avatar/name/Follow row
      // (which ends well short of 370px) and the "2:02 PM · ..." row
      // further down. Scrolls together with the iframe (both are normal
      // children of the same scrollable wrap -- see this shape's CSS)
      // rather than staying pinned mid-content as the card scrolls.
      if (embedInfo.shape === 'twitter') {
        var logoCover = document.createElement('div');
        logoCover.className = 'lively-link-preview-embed-twitter-cover';
        wrap.appendChild(logoCover);
      }

      // No separate "Open in <provider>" caption here -- every one of the
      // four embeddable providers' own official players (Spotify/YouTube/
      // SoundCloud/Apple Music) already carries its own "open externally"
      // affordance inside the iframe itself (confirmed live for YouTube:
      // title/channel links and a "Watch on YouTube" badge all present in
      // the embedded player's own UI), so a redundant link alongside it was
      // pure visual clutter that didn't do anything the embed itself didn't
      // already offer.

      ['mousedown', 'click'].forEach(function (t) {
        wrap.addEventListener(t, function (e) { e.stopPropagation(); });
      });
      return wrap;
    }

    // Bluesky post variant — a self-rendered card from LinkPreviewServer.js's
    // own AT Protocol API lookup (see that file's "Bluesky posts" section),
    // NOT an embed/iframe: Bluesky's own oEmbed response is a <script>-tag
    // widget, not a sandboxed iframe, and this codebase never renders
    // third-party markup directly (see buildLinkPreviewCard's oEmbed
    // handling) — so this builds plain DOM from individually-whitelisted
    // fields instead, the same trust posture as the generic static card
    // just above. A real <a> (not a div) is fine here, unlike the iframe
    // embed case — nothing inside needs to be interactive content.
    function _buildBlueskyCard(data) {
      var b = data.bluesky;
      var card = document.createElement('a');
      card.className = 'lively-link-preview-card lively-link-preview-bluesky';
      card.href = safeHref(data.url);
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
      card.contentEditable = 'false';

      var header = document.createElement('div');
      header.className = 'lively-bsky-header';
      var safeAvatar = b.authorAvatar ? safeHref(b.authorAvatar) : null;
      if (safeAvatar && safeAvatar !== '#') {
        var avatar = document.createElement('img');
        avatar.className = 'lively-bsky-avatar';
        avatar.src = safeAvatar;
        avatar.alt = '';
        avatar.loading = 'lazy';
        avatar.onerror = function () { avatar.remove(); };
        header.appendChild(avatar);
      }
      var authorBlock = document.createElement('div');
      authorBlock.className = 'lively-bsky-authorblock';
      if (b.authorDisplayName) {
        var displayName = document.createElement('div');
        displayName.className = 'lively-bsky-displayname';
        displayName.textContent = b.authorDisplayName;
        authorBlock.appendChild(displayName);
      }
      if (b.authorHandle) {
        var handle = document.createElement('div');
        handle.className = 'lively-bsky-handle';
        handle.textContent = '@' + b.authorHandle;
        authorBlock.appendChild(handle);
      }
      header.appendChild(authorBlock);
      card.appendChild(header);

      if (b.text) {
        var text = document.createElement('div');
        text.className = 'lively-bsky-text';
        text.textContent = b.text;
        card.appendChild(text);
      }

      if (b.images && b.images.length) {
        var imgGrid = document.createElement('div');
        imgGrid.className = 'lively-bsky-images';
        imgGrid.setAttribute('data-count', String(b.images.length));
        b.images.forEach(function (im) {
          var safeThumb = im.thumb ? safeHref(im.thumb) : null;
          if (!safeThumb || safeThumb === '#') return;
          var thumbImg = document.createElement('img');
          thumbImg.src = safeThumb;
          thumbImg.alt = im.alt || '';
          thumbImg.loading = 'lazy';
          thumbImg.onerror = function () { thumbImg.remove(); };
          imgGrid.appendChild(thumbImg);
        });
        if (imgGrid.childNodes.length) card.appendChild(imgGrid);
      }

      var hasStats = b.likeCount || b.repostCount || b.replyCount;
      if (hasStats) {
        var stats = document.createElement('div');
        stats.className = 'lively-bsky-stats';
        function stat(count, icon) {
          if (!count) return;
          var span = document.createElement('span');
          var iconSpan = document.createElement('span');
          iconSpan.className = 'material-symbols-rounded';
          iconSpan.textContent = icon;
          span.appendChild(iconSpan);
          span.appendChild(document.createTextNode(' ' + count));
          stats.appendChild(span);
        }
        stat(b.likeCount, 'favorite');
        stat(b.repostCount, 'repeat');
        stat(b.replyCount, 'chat_bubble');
        card.appendChild(stats);
      }

      ['mousedown', 'click'].forEach(function (t) {
        card.addEventListener(t, function (e) { e.stopPropagation(); });
      });
      return card;
    }

    function _insertLinkPreviewCard(afterEl, data) {
      if (!afterEl.parentNode) return; // container was replaced/removed meanwhile
      afterEl.parentNode.insertBefore(buildLinkPreviewCard(data), afterEl.nextSibling);
    }

    // Shared confirm-gate + Pyodide Worker orchestration for a Python code
    // cell's Run button (CodeEditorSpec.md §2.3) -- used by both
    // WikiEditor's live NodeView and this module's own hydrateCodeCells, so
    // the click-to-run confirm + Worker call only exists once. callbacks:
    // {onStatus(text), onDone(err, response)}. Fires the confirm dialog on
    // every call -- no remembered trust (a wiki page's source can change
    // between two clicks; see the schema comment in WikiEditor.js).
    //
    // `language` (default 'python') picks the runtime from the registry above.
    // A language with confirmBeforeRun (Python) asks first; one without (Scheme:
    // no ambient access to network/DOM/storage; the run is still click-only)
    // starts straight away. A 'transcript' language drives its worker
    // singleton, which streams output: callbacks.onSegments(segments),
    // onNeedInput() and onDone(err, {state}) -- see createSchemeOutput below
    // for rendering. An id this build has no row for never runs.
    function runCodeCell(source, callbacks, language) {
      callbacks = callbacks || {};
      var onDone = callbacks.onDone || function () {};
      var def = codeCellLanguage(language);
      if (!def.known) { onDone(new Error('This build has no runtime for ' + def.label + ' cells')); return; }
      var start = def.output === 'transcript'
        ? function () { _runTranscriptCell(def, source, callbacks); }
        : function () { _runPythonCell(def, source, callbacks); };
      if (!def.confirmBeforeRun) { start(); return; }
      if (typeof $world === 'undefined' || !$world.multipleChoicePrompt) { onDone(new Error('Run unavailable')); return; }
      $world.multipleChoicePrompt(
        'This Python cell is untrusted and runs locally in your own browser ' +
        '(via Pyodide/WebAssembly) with the same page privileges as any other script.',
        ['Run', 'Cancel'],
        function (choice) { if (choice === 'Run') start(); }
      );
    }

    function _runPythonCell(def, source, callbacks) {
      var onStatus = callbacks.onStatus || function () {};
      var onDone = callbacks.onDone || function () {};
      if (typeof lively === 'undefined' || !lively.require) { onDone(new Error('Run unavailable')); return; }
      lively.require(def.controller).toRun(function () {
        var pyodideWorker = codeCellGlobal(def.controller);
        onStatus(def.loadingText);
        pyodideWorker.ensureReady(function (err) {
          if (err) { onStatus('Error'); onDone(err, null); return; }
          onStatus('Running…');
          pyodideWorker.run(source, function (runErr, response) { onDone(runErr, response); });
        });
      });
    }

    // Stops whatever cell is currently running on this page's shared
    // interpreter (CodeEditorSpec.md §2.3's one-worker-per-page model) --
    // a real worker.terminate(), same acknowledged can't-interrupt-mid-
    // computation limitation as lively.jenga3d.Worker.
    //
    // Returns true when the stop is cooperative and the run's own onDone will
    // still report the outcome (Scheme: environment survives); false when the
    // run was torn down immediately and the caller should update its own UI.
    function stopCodeCell(language) {
      if (typeof lively === 'undefined' || !lively.identity) return false;
      var def = codeCellLanguage(language);
      if (!def.known) return false;
      if (def.cooperativeStop) {
        // Stop while the engine is still loading: cancel the pending start.
        if (_startPending[def.id]) { _startPending[def.id].cancelled = true; return true; }
        var controller = codeCellGlobal(def.controller);
        if (!controller) return false;
        if (!controller.isRunning()) return false;
        controller.interrupt();
        return true;
      }
      var worker = codeCellGlobal(def.controller);
      if (!worker) return false;
      worker.terminate();
      return false;
    }

    // Fresh environment for the page, for a language with hasReset (Scheme:
    // core library only). Python cells have no equivalent. thenDo(err).
    function resetCodeCell(language, thenDo) {
      thenDo = thenDo || function () {};
      var def = codeCellLanguage(language);
      var controller = def.hasReset ? codeCellGlobal(def.controller) : null;
      if (!controller || typeof lively === 'undefined' || !lively.identity) { thenDo(null); return; }
      controller.reset(thenDo);
    }

    // Answers a transcript cell's pending read (text === null: end of input).
    function provideCodeCellInput(text, language) {
      var controller = codeCellGlobal(codeCellLanguage(language).controller);
      if (!controller || typeof controller.provideInput !== 'function') return;
      controller.provideInput(text);
    }

    // The run currently waiting for each transcript language's engine to
    // load, by language id, so a Stop click in that window can cancel it (see
    // stopCodeCell).
    var _startPending = {};

    function _runTranscriptCell(def, source, callbacks) {
      var onStatus = callbacks.onStatus || function () {};
      var onDone = callbacks.onDone || function () {};
      if (typeof lively === 'undefined' || !lively.require) { onDone(new Error('Run unavailable')); return; }
      var pending = { cancelled: false };
      _startPending[def.id] = pending;
      // A graphics language also needs the turtle painter loaded before its first draw message arrives.
      var needs = def.graphics ? [def.controller, 'lively.identity.TurtleCanvas'] : [def.controller];
      lively.require.apply(lively, needs).toRun(function () {
        var worker = codeCellGlobal(def.controller);
        onStatus(def.loadingText);
        worker.ensureReady(function (err) {
          if (_startPending[def.id] === pending) delete _startPending[def.id];
          if (pending.cancelled) { onDone(null, { state: 'stopped' }); return; }
          if (err) { onStatus('Error'); onDone(err, null); return; }
          onStatus('Running…');
          worker.run(source, {
            onSegments: callbacks.onSegments,
            onDraw: callbacks.onDraw,          // graphics languages only; a controller that never posts `draw` ignores it
            onNeedInput: callbacks.onNeedInput,
            onDone: function (runErr, result) { onDone(runErr, result); },
          }, { language: def.id });   // only a controller made with sendLanguage forwards it (Logo: logo vs tpn)
        });
      });
    }

    // The badge text: a small icon, then the language name. An id with no
    // registry row is shown as itself.
    function codeCellLanguageLabel(language) {
      return codeCellLanguage(language).label;
    }

    // Incremental renderer for a Scheme cell's output pane (ordered
    // transcript, unlike Python's one-shot stdout/stderr/result). Shared by
    // WikiEditor's live NodeView and this module's hydrateCodeCells.
    //   start()            clear the pane for a new run
    //   append(segments)   segments from a worker: stdout | value | warning | error | status (an error may carry
    //                      errorClass, shown as a label; a status may carry tone: ok | note | bad)
    //   showInput(submit)  inline one-line input; submit(text|null) answers the cell's read
    //   graphicsHost()     for a graphics language (registry `graphics: true`): the element holding the turtle canvas,
    //                      created on the first call and placed above the transcript, or the existing one on later calls.
    //                      A pane that never calls this renders exactly as before (Scheme and ML cells never do), so do
    //                      not call it speculatively. It only makes the empty <canvas>; draw() does the drawing.
    //   draw(ops, turtle)  the turtle's picture for a graphics language: draw operations from the worker and the turtle's
    //                      state (or null). Creates the canvas and its painter (lively.identity.TurtleCanvas) on the first
    //                      operations; later calls add to the picture. A pane never given operations never has a canvas.
    //   finish(state, err) end of run; state: done | error | stopped | exit
    function createSchemeOutput(outputEl) {
      var lastPre = null, lastKind = null, anyContent = false, inputRow = null, graphicsEl = null, painter = null, lastTurtle = null;

      function addPre(kind, cls, text) {
        var pre = document.createElement('pre');
        if (cls) pre.className = cls;
        pre.textContent = text;
        if (inputRow && inputRow.parentNode === outputEl) outputEl.insertBefore(pre, inputRow);
        else outputEl.appendChild(pre);
        lastPre = pre; lastKind = kind; anyContent = true;
        return pre;
      }
      function removeInput() {
        if (inputRow && inputRow.parentNode) inputRow.parentNode.removeChild(inputRow);
        inputRow = null;
      }

      return {
        start: function () {
          if (painter) painter.destroy();
          outputEl.innerHTML = '';
          outputEl.classList.remove('lively-code-cell-output-empty');
          lastPre = null; lastKind = null; anyContent = false; inputRow = null; graphicsEl = null; painter = null; lastTurtle = null;
        },
        // The turtle's drawing for this run (a worker `draw` message): the painter is made on the first operations, so a cell
        // that only prints text never gets a canvas. `turtle` is the turtle's state when it changed; the latest one is kept so
        // a painter created later starts with it. Needs lively.identity.TurtleCanvas (runCodeCell loads it for graphics
        // languages).
        draw: function (ops, turtle) {
          if (turtle) lastTurtle = turtle;
          if (!painter) {
            if (!ops || !ops.length) return;
            if (!(lively.identity && lively.identity.TurtleCanvas)) return;
            painter = lively.identity.TurtleCanvas.create(this.graphicsHost());
          }
          painter.apply(ops, lastTurtle);
        },
        graphicsHost: function () {
          if (graphicsEl && graphicsEl.parentNode === outputEl) return graphicsEl;
          graphicsEl = document.createElement('div');
          graphicsEl.className = 'lively-code-cell-graphics';
          var canvas = document.createElement('canvas');
          canvas.className = 'lively-code-cell-canvas';
          canvas.width = 500; canvas.height = 500;   // the drawing buffer; CSS scales the box (Phase 2 sizes it for the display)
          graphicsEl.appendChild(canvas);
          outputEl.insertBefore(graphicsEl, outputEl.firstChild);
          outputEl.classList.remove('lively-code-cell-output-empty');
          anyContent = true;   // a picture is output: finish() must not replace the pane with "Ran with no output."
          return graphicsEl;
        },
        append: function (segments) {
          (segments || []).forEach(function (seg) {
            if (seg.kind === 'stdout') {
              if (lastKind === 'stdout' && lastPre) lastPre.textContent += seg.text;
              else addPre('stdout', 'lively-code-cell-stdout', seg.text);
            } else if (seg.kind === 'value') {
              addPre('value', 'lively-code-cell-value', seg.text);
            } else if (seg.kind === 'error') {
              var errPre = addPre('error', 'lively-code-cell-stderr', seg.text);
              if (seg.errorClass) {
                var label = document.createElement('span');
                label.className = 'lively-code-cell-errclass';
                label.textContent = seg.errorClass + ':';
                errPre.insertBefore(label, errPre.firstChild);
              }
            } else if (seg.kind === 'warning') {
              addPre('warning', 'lively-code-cell-warn', seg.text);
            } else {
              addPre('status', 'lively-code-cell-note' + (seg.tone && seg.tone !== 'note' ? ' lively-code-cell-tone-' + seg.tone : ''), seg.text);
            }
          });
        },
        showInput: function (submit) {
          removeInput();
          inputRow = document.createElement('div');
          inputRow.className = 'lively-code-cell-input-row';
          var input = document.createElement('input');
          input.type = 'text';
          input.spellcheck = false;
          input.placeholder = 'Type a line and press Enter';
          var eofBtn = document.createElement('button');
          eofBtn.type = 'button';
          eofBtn.textContent = 'End input';
          function answer(text) {
            removeInput();
            if (text !== null) addPre('echo', 'lively-code-cell-echo', text + '\n');
            submit(text);
          }
          input.addEventListener('mousedown', function (e) { e.stopPropagation(); });
          input.addEventListener('keydown', function (e) {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); answer(input.value); }
          });
          eofBtn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); answer(null); });
          inputRow.appendChild(input);
          inputRow.appendChild(eofBtn);
          outputEl.appendChild(inputRow);
          anyContent = true;
          input.focus();
        },
        finish: function (state, err) {
          removeInput();
          if (err) addPre('error', 'lively-code-cell-stderr', err.message || String(err));
          if (state === 'stopped' && !err && lastKind !== 'status') addPre('status', 'lively-code-cell-note', 'Stopped');
          if (!anyContent) {
            outputEl.classList.add('lively-code-cell-output-empty');
            outputEl.textContent = 'Ran with no output.';
          }
        },
      };
    }

    // A private/shared attachment's src is only known once decrypted (see
    // FileCrypto.resolveAttachmentUrl) — a snapshot rendered before that
    // has objId set and src empty. These two helpers emit a placeholder
    // hydrateAttachments can find and resolve in place, mirroring the
    // .lively-embedded-part[data-obj-id] convention below.
    function attachmentPlaceholderClass() {
      return ' lively-attachment-placeholder lively-attachment-loading';
    }
    function attachmentPlaceholderAttrs(node) {
      var objId = (node.attrs && node.attrs.objId) || '';
      return ' data-obj-id="' + escapeAttr(objId) + '"';
    }

    function pmNodeToHtml(node) {
      if (!node) return '';
      switch (node.type) {
        case 'paragraph':
          return '<p' + alignIndentAttr(node) + '>' + inlineContent(node.content) + '</p>';
        case 'heading': {
          var level = Math.min(6, Math.max(1, (node.attrs && node.attrs.level) ? node.attrs.level : 1));
          return '<h' + level + alignIndentAttr(node) + '>' + inlineContent(node.content) + '</h' + level + '>';
        }
        case 'bullet_list':
          return '<ul>' + (node.content || []).map(pmNodeToHtml).join('') + '</ul>';
        case 'ordered_list':
          return '<ol>' + (node.content || []).map(pmNodeToHtml).join('') + '</ol>';
        case 'check_list':
          return '<ul data-type="checklist" class="lively-checklist">' + (node.content || []).map(pmNodeToHtml).join('') + '</ul>';
        case 'list_item': {
          var liChecked = node.attrs && node.attrs.checked;
          var liStyle = alignIndentAttr(node);
          if (liChecked === true || liChecked === false) liStyle += ' data-checked="' + liChecked + '"';
          return '<li' + liStyle + '>' + (node.content || []).map(pmNodeToHtml).join('') + '</li>';
        }
        case 'blockquote':
          return '<blockquote>' + (node.content || []).map(pmNodeToHtml).join('') + '</blockquote>';
        case 'code_block':
          return renderHighlightedCode(node);
        case 'code_cell':
          return renderCodeCell(node);
        case 'hard_break':
          return '<br>';
        case 'image':
          return imageTagHtml(node, '', false);
        case 'video': {
          var vsrc = (node.attrs && node.attrs.src) || '';
          if (!vsrc) {
            if (node.attrs && node.attrs.objId) {
              return '<video class="lively-postcard-video' + attachmentPlaceholderClass() + '"' +
                     attachmentPlaceholderAttrs(node) + ' controls preload="metadata"></video>';
            }
            return '';
          }
          return '<video class="lively-postcard-video" controls preload="metadata" src="' + escapeAttr(vsrc) + '"></video>';
        }
        case 'audio': {
          var asrc = (node.attrs && node.attrs.src) || '';
          if (!asrc) {
            if (node.attrs && node.attrs.objId) {
              return '<audio class="lively-postcard-audio' + attachmentPlaceholderClass() + '"' +
                     attachmentPlaceholderAttrs(node) + ' controls preload="metadata"></audio>';
            }
            return '';
          }
          return '<audio class="lively-postcard-audio" controls preload="metadata" src="' + escapeAttr(asrc) + '"></audio>';
        }
        case 'math_inline':
          return renderKatex((node.attrs && node.attrs.value) || '', false);
        case 'math_display':
          return renderKatex((node.attrs && node.attrs.value) || '', true);
        case 'embeddedPart': {
          // BUG FIX: this used to emit only data-obj-id, dropping
          // handle/cid/embed-id — hydrateEmbeddedParts (and, previously, no
          // code at all) has no way to look up which account's object store
          // to fetch the part from without data-handle, so every embedded
          // part in a read-only view (feed, permalink page) rendered as a
          // permanent, un-clickable "[Embedded Part: <objId>]" text stub.
          // Matches the schema's own toDOM (PostCardEditor.js/WikiEditor.js)
          // attr-for-attr, including the class name, so the same
          // .lively-embedded-part querySelector finds both.
          var attrs = node.attrs || {};
          var partId = attrs.objId || '(embedded)';
          return '<div class="lively-embedded-part" data-obj-id="' + escapeAttr(attrs.objId || '') +
                 '" data-cid="' + escapeAttr(attrs.cid || '') +
                 '" data-handle="' + escapeAttr(attrs.handle || '') +
                 '" data-embed-id="' + escapeAttr(attrs.embedId || '') + '">' +
                 '[Embedded Part: ' + escapeHtml(partId) + ']</div>';
        }
        case 'link_preview_card':
          return linkPreviewCardHtml(node.attrs || {});
        default:
          if (node.content) return (node.content || []).map(pmNodeToHtml).join('');
          return '';
      }
    }

    // String-emitting counterpart of buildLinkPreviewCard (that one builds
    // real DOM, for the live editor's NodeView and the DOM-scan hydration
    // fallback; this one is used by pmNodeToHtml's string-concatenation
    // render path) — kept visually in sync by hand, same three-way-
    // duplication convention this file's header comment already documents
    // for every other node type. data-* attrs round-trip through the
    // schema's own toDOM/parseDOM (PostCardEditor.js/WikiEditor.js) exactly
    // like .lively-embedded-part above.
    //
    // _suppressEmbeds (set by blocksToHtml's opts.suppressEmbeds, via
    // buildPreviewSplit's feedMode): a condensed feed row never mounts a
    // card or iframe for this node — just a plain text link — matching this
    // file's pre-existing "no preview card per row" posture for
    // hydrateLinkPreviews (see MAX_LINK_PREVIEWS_PER_CONTAINER's comment),
    // which otherwise wouldn't apply here since this node is reachable from
    // any generic doc-walk, not just hydrateLinkPreviews's own call sites.
    function linkPreviewCardHtml(attrs) {
      var dataAttrs = ' data-url="' + escapeAttr(attrs.url || '') +
        '" data-title="' + escapeAttr(attrs.title || '') +
        '" data-description="' + escapeAttr(attrs.description || '') +
        '" data-image="' + escapeAttr(attrs.image || '') +
        '" data-site-name="' + escapeAttr(attrs.siteName || '') +
        '" data-provider="' + escapeAttr(attrs.provider || '') +
        '" data-embed-url="' + escapeAttr(attrs.embedUrl || '') +
        '" data-bluesky="' + escapeAttr(attrs.bluesky ? JSON.stringify(attrs.bluesky) : '') + '"';

      if (_suppressEmbeds) {
        var label = attrs.title || attrs.siteName || attrs.url || '';
        return '<a href="' + escapeAttr(safeHref(attrs.url || '')) + '" rel="noopener noreferrer"' +
          dataAttrs + '>' + escapeHtml(label) + '</a>';
      }

      if (attrs.provider === 'bluesky' && attrs.bluesky) return blueskyCardHtml(attrs, dataAttrs);

      var embedInfo = attrs.embedUrl ? _embedHostInfo(attrs.embedUrl) : null;
      if (embedInfo) {
        return '<div class="lively-link-preview-card lively-link-preview-embed" data-embed-shape="' +
          escapeAttr(embedInfo.shape) + '"' + dataAttrs + '>' +
          '<iframe src="' + escapeAttr(attrs.embedUrl) + '" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" ' +
          'sandbox="allow-scripts allow-same-origin allow-popups allow-presentation" allowfullscreen ' +
          'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" ' +
          // scrolling="no" -- see _buildLinkPreviewEmbed's identical fix for
          // why this is needed for Instagram (suppresses a second,
          // unstyleable scrollbar its own page forces regardless of the
          // resize hydrateLinkPreviewEmbeds performs after insertion) and
          // for Reddit/Twitter (suppresses a nested scrollbar inside the
          // wrapper's own pink one for a post taller than its static height
          // guess).
          (embedInfo.shape === 'instagram' || embedInfo.shape === 'reddit' || embedInfo.shape === 'twitter' ? 'scrolling="no" ' : '') +
          'title="' + escapeAttr(attrs.title || embedInfo.label) + '"></iframe>' +
          // Covers Twitter's own brand-logo link -- see _buildLinkPreviewEmbed's
          // identical element for why this exists and the measurements it's based on.
          (embedInfo.shape === 'twitter' ? '<div class="lively-link-preview-embed-twitter-cover"></div>' : '') +
          '</div>';
      }

      var safeImage = attrs.image ? safeHref(attrs.image) : null;
      var imgHtml = (safeImage && safeImage !== '#')
        ? '<div class="lively-link-preview-card-image-wrap"><img src="' + escapeAttr(safeImage) + '" alt="" loading="lazy"></div>'
        : '';
      var textHtml = (attrs.siteName ? '<div class="lively-link-preview-card-site">' + escapeHtml(attrs.siteName) + '</div>' : '') +
        (attrs.title ? '<div class="lively-link-preview-card-title">' + escapeHtml(attrs.title) + '</div>' : '') +
        (attrs.description ? '<div class="lively-link-preview-card-desc">' + escapeHtml(attrs.description) + '</div>' : '');
      return '<a class="lively-link-preview-card" href="' + escapeAttr(safeHref(attrs.url || '')) +
        '" target="_blank" rel="noopener noreferrer"' + dataAttrs + '>' +
        imgHtml + '<div class="lively-link-preview-card-text">' + textHtml + '</div></a>';
    }

    // String-emitting counterpart of _buildBlueskyCard above — see that
    // function's header comment for why this is self-rendered DOM from
    // whitelisted fields rather than an embed/iframe.
    function blueskyCardHtml(attrs, dataAttrs) {
      var b = attrs.bluesky;
      var safeAvatar = b.authorAvatar ? safeHref(b.authorAvatar) : null;
      var avatarHtml = (safeAvatar && safeAvatar !== '#')
        ? '<img class="lively-bsky-avatar" src="' + escapeAttr(safeAvatar) + '" alt="" loading="lazy">' : '';
      var authorBlockHtml = '<div class="lively-bsky-authorblock">' +
        (b.authorDisplayName ? '<div class="lively-bsky-displayname">' + escapeHtml(b.authorDisplayName) + '</div>' : '') +
        (b.authorHandle ? '<div class="lively-bsky-handle">@' + escapeHtml(b.authorHandle) + '</div>' : '') +
        '</div>';
      var textHtml = b.text ? '<div class="lively-bsky-text">' + escapeHtml(b.text) + '</div>' : '';
      var images = (b.images || []).map(function (im) {
        var safeThumb = im.thumb ? safeHref(im.thumb) : null;
        if (!safeThumb || safeThumb === '#') return '';
        return '<img src="' + escapeAttr(safeThumb) + '" alt="' + escapeAttr(im.alt || '') + '" loading="lazy">';
      }).join('');
      var imagesHtml = images ? '<div class="lively-bsky-images" data-count="' + (b.images || []).length + '">' + images + '</div>' : '';
      var statsParts = [];
      if (b.likeCount) statsParts.push('<span><span class="material-symbols-rounded">favorite</span> ' + b.likeCount + '</span>');
      if (b.repostCount) statsParts.push('<span><span class="material-symbols-rounded">repeat</span> ' + b.repostCount + '</span>');
      if (b.replyCount) statsParts.push('<span><span class="material-symbols-rounded">chat_bubble</span> ' + b.replyCount + '</span>');
      var statsHtml = statsParts.length ? '<div class="lively-bsky-stats">' + statsParts.join('') + '</div>' : '';

      return '<a class="lively-link-preview-card lively-link-preview-bluesky" href="' +
        escapeAttr(safeHref(attrs.url || '')) + '" target="_blank" rel="noopener noreferrer"' + dataAttrs + '>' +
        '<div class="lively-bsky-header">' + avatarHtml + authorBlockHtml + '</div>' +
        textHtml + imagesHtml + statsHtml + '</a>';
    }

    // §10.1 align/indent (matches PostCardEditor.js's _alignIndentAttrs).
    function alignIndentAttr(node) {
      var attrs = node.attrs || {};
      var style = '';
      if (attrs.align && attrs.align !== 'left') style += 'text-align:' + attrs.align + ';';
      if (attrs.indent) style += 'margin-left:' + (attrs.indent * 24) + 'px;';
      var lh = parseFloat(attrs.lineHeight);
      if (lh > 0) style += 'line-height:' + lh + ';';
      return style ? ' style="' + escapeAttr(style) + '"' : '';
    }

    function inlineContent(content) {
      if (!content) return '';
      return content.map(function (node) {
        if (node.type === 'text') {
          var text = escapeHtml(node.text || '');
          (node.marks || []).forEach(function (mark) {
            switch (mark.type) {
              case 'bold':   text = '<strong>' + text + '</strong>'; break;
              case 'italic': text = '<em>' + text + '</em>'; break;
              case 'code':   text = '<code>' + text + '</code>'; break;
              case 'underline':   text = '<u>' + text + '</u>'; break;
              case 'strike':      text = '<s>' + text + '</s>'; break;
              case 'superscript': text = '<sup>' + text + '</sup>'; break;
              case 'subscript':   text = '<sub>' + text + '</sub>'; break;
              case 'textColor':
                if (mark.attrs && mark.attrs.color)
                  text = '<span style="color:' + escapeAttr(mark.attrs.color) + '">' + text + '</span>';
                break;
              case 'backgroundColor':
                if (mark.attrs && mark.attrs.color)
                  text = '<span style="background-color:' + escapeAttr(mark.attrs.color) + '">' + text + '</span>';
                break;
              case 'fontFamily':
                if (mark.attrs && mark.attrs.family)
                  text = '<span style="font-family:' + escapeAttr(mark.attrs.family) + '">' + text + '</span>';
                break;
              case 'fontSize':
                if (mark.attrs && mark.attrs.size)
                  text = '<span style="font-size:' + escapeAttr(mark.attrs.size) + '">' + text + '</span>';
                break;
              case 'link': {
                var raw  = mark.attrs && mark.attrs.href ? mark.attrs.href : '#';
                var href = escapeAttr(safeHref(raw));
                text = '<a href="' + href + '" rel="noopener noreferrer">' + text + '</a>';
                break;
              }
            }
          });
          return text;
        }
        return pmNodeToHtml(node);
      }).join('');
    }

    // Client-side KaTeX render for the read-only feed/playback/standalone-page
    // paths (window.katex comes from postcard-runtime.js). Falls back to the
    // raw LaTeX source, escaped, if katex isn't loaded yet or input is malformed.
    function renderKatex(value, displayMode) {
      var tag = displayMode ? 'pre' : 'code';
      if (!value) return '<' + tag + ' class="math-' + (displayMode ? 'display' : 'inline') + '"></' + tag + '>';
      var katex = (typeof window !== 'undefined' && window.katex) || null;
      if (!katex) return '<' + tag + ' class="math-' + (displayMode ? 'display' : 'inline') + '">' + escapeHtml(value) + '</' + tag + '>';
      try {
        return katex.renderToString(value, { throwOnError: true, displayMode: displayMode });
      } catch (e) {
        return '<' + tag + ' class="math-' + (displayMode ? 'display' : 'inline') + ' math-error">' +
               escapeHtml(value) + '</' + tag + '>';
      }
    }

    // Client-side syntax-highlighted code_block render (window.hljs comes
    // from postcard-runtime.js). Reads raw text directly from node.content —
    // hljs's .value output already escapes it, so running it through
    // escapeHtml() again would double-escape entities.
    function renderHighlightedCode(node) {
      var text = (node.content || []).map(function (n) { return n.text || ''; }).join('');
      if (!text) return '<pre><code class="hljs"></code></pre>';
      var hljs = (typeof window !== 'undefined' && window.hljs) || null;
      if (!hljs) return '<pre><code class="hljs">' + escapeHtml(text) + '</code></pre>';
      try {
        return '<pre><code class="hljs">' + hljs.highlightAuto(text).value + '</code></pre>';
      } catch (e) {
        return '<pre><code class="hljs">' + escapeHtml(text) + '</code></pre>';
      }
    }

    // Runnable Python cell (CodeEditorSpec.md §2.3), read-only/hydrated
    // rendering. Matches the schema's toDOM shape (div.lively-code-cell,
    // pre.lively-code-cell-source holding the plain source text) so a
    // pasted-back copy still round-trips through the schema's parseDOM --
    // plus the interactive chrome (Run/Stop/status, empty output
    // placeholder) hydrateCodeCells wires up below. The outer div also
    // carries lively-code-cell-node so it picks up the exact same CSS as
    // the live editor's NodeView (see _ensureMediaStyle's header note on
    // why this is a second, deliberately-identical copy of those rules).
    function renderCodeCell(node) {
      var attrs = node.attrs || {};
      var source = attrs.source || '';
      var hljs = (typeof window !== 'undefined' && window.hljs) || null;
      var def = codeCellLanguage(attrs.language);
      // A language this build has no row for: the source as plain text, a note
      // in place of the output pane, and no Run button. data-language keeps
      // the original id so a copy of the cell still round-trips.
      if (!def.known) {
        return '<div class="lively-code-cell lively-code-cell-node" data-language="' + escapeAttr(def.id) + '">' +
               '<div class="lively-code-cell-header">' +
                 '<span class="lively-code-cell-badge">' + escapeHtml(def.label) + '</span>' +
               '</div>' +
               '<pre class="lively-code-cell-source"><code class="hljs">' + escapeHtml(source) + '</code></pre>' +
               '<div class="lively-code-cell-output lively-code-cell-output-empty">' +
                 'This page uses a runtime this build doesn\'t have, so this cell can\'t run.</div>' +
             '</div>';
      }
      var language = def.id;
      var highlighted;
      try { highlighted = hljs ? hljs.highlight(source, { language: def.hljsId }).value : escapeHtml(source); }
      catch (e) { highlighted = escapeHtml(source); }
      return '<div class="lively-code-cell lively-code-cell-node" data-language="' +
             escapeAttr(language) + '">' +
             '<div class="lively-code-cell-header">' +
               '<span class="lively-code-cell-badge">' + def.label + '</span>' +
               '<button type="button" class="lively-code-cell-run-btn" data-hydrate="code-cell">Run</button>' +
               '<button type="button" class="lively-code-cell-stop-btn">Stop</button>' +
               (def.hasReset ? '<button type="button" class="lively-code-cell-reset-btn">Reset</button>' : '') +
               '<span class="lively-code-cell-status">Idle</span>' +
             '</div>' +
             '<pre class="lively-code-cell-source"><code class="hljs">' + highlighted + '</code></pre>' +
             '<div class="lively-code-cell-output lively-code-cell-output-empty">Run to see output.</div>' +
             (def.help ? '<div class="lively-code-cell-help">' + escapeHtml(def.help) + '</div>' : '') +
           '</div>';
    }

    // Deterministic seeded-PRNG "blockie" identicon, rendered to a canvas and
    // returned as a data URL. Extracted from ProfileCard.js's inline avatar
    // fallback (same xorshift128 PRNG + mirrored-cell layout) so PostCardView
    // can embed it as a plain <img src="..."> alongside ProfileCard's morphic
    // Image use of the same bits — keep both in sync if this changes.
    function identiconDataUrl(seedStr, sizePx) {
      var seed = (seedStr || '?').toLowerCase();
      var SZ = 8, SC = Math.ceil(sizePx / SZ);
      var rs = [0, 0, 0, 0];
      for (var i = 0; i < seed.length; i++) {
        rs[i % 4] = ((rs[i % 4] << 5) - rs[i % 4]) + seed.charCodeAt(i);
        rs[i % 4] |= 0;
      }
      function rnd() {
        var t = rs[0] ^ (rs[0] << 11);
        rs[0] = rs[1]; rs[1] = rs[2]; rs[2] = rs[3];
        rs[3] = (rs[3] ^ (rs[3] >> 19) ^ t ^ (t >> 8));
        return (rs[3] >>> 0) / ((1 << 31) >>> 0);
      }
      function hsl() {
        return 'hsl(' + Math.floor(rnd() * 360) + ',' +
          (rnd() * 60 + 40) + '%,' +
          ((rnd() + rnd() + rnd() + rnd()) * 25) + '%)';
      }
      var fg = hsl(), bg = hsl(), spot = hsl();
      var half = Math.ceil(SZ / 2);
      var cells = [];
      for (var r = 0; r < SZ; r++) {
        var row = [];
        for (var x = 0; x < half; x++) row.push(Math.floor(rnd() * 2.3));
        var mir = row.slice(0, SZ - half).reverse();
        cells.push(row.concat(mir));
      }
      var bc = document.createElement('canvas');
      bc.width = bc.height = SZ * SC;
      var bctx = bc.getContext('2d');
      cells.forEach(function (row, r) {
        row.forEach(function (v, col) {
          bctx.fillStyle = v === 1 ? fg : v === 2 ? spot : bg;
          bctx.fillRect(col * SC, r * SC, SC, SC);
        });
      });
      return bc.toDataURL();
    }

    // Shortened display form of a DID: first 20 + last 12 chars, matching
    // the pattern originally inline in ProfileCard.js's identity panel.
    function truncateDid(did) {
      var s = String(did || '');
      return s.length > 36 ? s.slice(0, 20) + '…' + s.slice(-12) : s;
    }

    // The pink Material Symbols lock that marks an encrypted card or reply,
    // in place of the lock emoji. opts: { size (px, default 14), open (the
    // unlocked variant), color (default the brand pink) }. The glyph is a
    // ligature name in the icon font, so size it from `size` rather than by
    // measuring it (CLAUDE.md: the font loads async).
    var LOCK_PINK = '#E31361';
    function _lockGlyphStyle(opts) {
      var o = opts || {};
      // Single quotes around the font name: lockGlyphHtml embeds this in a
      // double-quoted style attribute.
      return "font-family:'Material Symbols Rounded';font-style:normal;font-weight:normal;" +
        'font-size:' + (o.size || 14) + 'px;line-height:1;color:' + (o.color || LOCK_PINK) + ';' +
        'display:inline-block;width:1em;height:1em;overflow:hidden;vertical-align:-0.2em;';
    }
    function lockGlyph(opts) {
      var el = document.createElement('span');
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = _lockGlyphStyle(opts);
      el.textContent = (opts && opts.open) ? 'lock_open' : 'lock';
      return el;
    }
    function lockGlyphHtml(opts) {
      return '<span aria-hidden="true" style="' + _lockGlyphStyle(opts) + '">' +
        ((opts && opts.open) ? 'lock_open' : 'lock') + '</span>';
    }

    // Shortened display form of a wallet address (e.g. "0x998b…c4a2"):
    // first 6 + last 4 chars, same truncate-in-the-middle idea as truncateDid.
    function truncateAddress(addr) {
      var s = String(addr || '');
      return s.length > 12 ? s.slice(0, 6) + '…' + s.slice(-4) : s;
    }

    // Head-truncate (not middle-truncate, unlike truncateDid/truncateAddress
    // above) arbitrary prose to maxChars, word-boundary-aware, ellipsis-
    // suffixed — for rendering a short preview *snippet* of body text, not
    // an opaque identifier. Differs from PostCardSerializer.js's private
    // _extractFirstBlockText: that's a save-time, single-block (content[0]
    // only), no-ellipsis, hard 200-char slice used only to derive
    // envelope.state.title. This is a render-time, exported,
    // multi-block-aggregate-input helper for body preview text (see
    // buildPreviewSplit below).
    function excerptText(text, maxChars) {
      var s = String(text || '').replace(/\s+/g, ' ').trim();
      maxChars = maxChars || 140;
      if (s.length <= maxChars) return s;
      var cut = s.slice(0, maxChars);
      var lastSpace = cut.lastIndexOf(' ');
      if (lastSpace > maxChars * 0.6) cut = cut.slice(0, lastSpace); // avoid an ugly mid-word cut when reasonable
      return cut.replace(/[,;:.\-–—]+$/, '') + '…';
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function escapeAttr(str) {
      return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Returns a safe href, or '#' if the scheme is not allow-listed.
    // Blocks javascript:, data:, vbscript:, etc. Allows http(s), mailto, and
    // relative/anchor URLs (no scheme).
    function safeHref(raw) {
      var s = String(raw || '').trim();
      var m = /^([a-z][a-z0-9+.\-]*):/i.exec(s);
      if (!m) return s; // relative or anchor — allowed
      var scheme = m[1].toLowerCase();
      if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return s;
      return '#';
    }

    // Location tag support — Plus Codes (Open Location Code), floored to 6
    // significant digits (~5.5km x 5.5km cell) so a location tag can never
    // be more precise than that, even transiently in memory before it's
    // ever sent anywhere. Requires window.OpenLocationCode
    // (core/lib/geo/geo-runtime.js) — callers ensure it's loaded first via
    // their own _ensureGeoRuntime. Server-side enforcement of this same
    // floor is an INDEPENDENT copy (core/servers/identity/PlusCode.js, same
    // rationale as this file's header note about _pmNodeToHtml) — this
    // client-side floor is a courtesy / defense-in-depth, not the trust
    // boundary.
    var LOCATION_CODE_LENGTH = 6;

    function encodeLocation(lat, lng) {
      if (!window.OpenLocationCode) return null;
      try {
        return new window.OpenLocationCode().encode(lat, lng, LOCATION_CODE_LENGTH);
      } catch (e) { return null; }
    }

    // Re-derives a floored Plus Code from a string of unknown/untrusted
    // precision (e.g. re-validating a previously-saved envelope's
    // state.location when reopening a card) — decode+re-encode, not
    // substring slicing, since Plus Codes place the '+' at a fixed offset
    // and support shortened forms a naive truncation would mangle. Returns
    // null if the code isn't a valid, full (decodable) Plus Code.
    function sanitizeLocationCode(code) {
      if (!window.OpenLocationCode || !code) return null;
      try {
        var olc = new window.OpenLocationCode();
        if (!olc.isValid(code) || !olc.isFull(code)) return null;
        var area = olc.decode(code);
        return olc.encode(area.latitudeCenter, area.longitudeCenter, LOCATION_CODE_LENGTH);
      } catch (e) { return null; }
    }

  }); // end module('lively.identity.PostCardUtils')
