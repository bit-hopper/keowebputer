/**
 * lively.identity.PostCardEditor
 *
 * BuildSpec morph — a windowed morph that embeds a ProseMirror EditorView
 * bound to a Y.Doc via ySyncPlugin. Handles live collaborative editing,
 * auto-save to identity envelopes, and toolbar actions.
 *
 * Architecture:
 *   - Extends lively.morphic.Box (windowed morph).
 *   - ProseMirror EditorView appended to renderContext().shapeNode (DOM).
 *     This is the same pattern as CodeEditor which appends CodeMirror.
 *   - ySyncPlugin + yUndoPlugin bind EditorView ↔ Y.Doc.getXmlFragment('prosemirror').
 *   - WebsocketProvider (y-websocket) attaches to LiveDocSyncServer at
 *     /livedoc-sync/<objId> on the same origin/port as the page itself
 *     (LiveDocSyncServer.js rides the shared WS listener, no separate
 *     port), using the postcard objId as room name.
 *   - Auto-save: debounced 2 s after the last change, serializes to a
 *     PostCardSerializer envelope and PUTs /@:handle/:objId.
 *   - Title field: plain text input above the editor, not part of the yDoc
 *     (synced separately as state.title in the envelope).
 *
 * CRITICAL (§9.3): Y.Doc MUST be created with gc: false before passing to
 * PostCardSerializer or attaching a WebsocketProvider. This file enforces
 * that at create-time.
 *
 * Entry point:
 *   lively.identity.PostCardEditor.open(handle, objId)
 *     — loads an existing postcard and opens the editor
 *   lively.identity.PostCardEditor.create(handle, options)
 *     — creates a new genesis postcard and opens the editor
 *
 * doNotSerialize list:
 *   editorView, yDoc, wsProvider
 *   (All three are non-serializable external objects; they are reconstructed
 *    from the envelope on next open.)
 *
 * Dependencies (must be loaded as plain scripts before first use):
 *   /lib/yjs/yjs.js, /lib/prosemirror/*, /lib/y-prosemirror/*, /lib/y-websocket/
 *
 * Dependencies (Lively modules, loaded via .requires):
 *   lively.identity.PostCardSerializer
 *   lively.identity.DID
 */

module('lively.identity.PostCardEditor')
  .requires(
    'lively.identity.PostCardSerializer',
    'lively.identity.DID',
    'lively.identity.WebAuthn',
    'lively.identity.WebKey',
    'lively.identity.FileCrypto',
    'lively.identity.AudienceRules',
    'lively.identity.PostcardAudience',
    'lively.identity.AudienceDialog',
    'lively.morphic.TextFormattingToolbar',
  )
  .toRun(function () {

    // See _resolveRecipientPubKeys (postcard-audit F25).
    var RECIPIENT_KEY_CACHE_TTL_MS = 60 * 1000;

    // The friends/orbit/lists the recorded audience is expanded against. Short, so a
    // person withdrawn from a list stops being sealed to within seconds of the next save.
    var AUDIENCE_CTX_TTL_MS = 30 * 1000;

    // Shared by paragraph/heading/list_item toDOM/parseDOM (§10.1 align/indent) —
    // module-scope so schema node specs can reference them without a `this`.
    var ALLOWED_ALIGN = { left: 1, center: 1, right: 1, justify: 1 };
    function _parseAlignIndent(dom) {
      var align = dom.style && dom.style.textAlign;
      var indent = dom.style && parseInt(dom.style.marginLeft, 10);
      var lineHeight = dom.style && parseFloat(dom.style.lineHeight);
      return {
        align: ALLOWED_ALIGN[align] ? align : 'left',
        indent: (indent > 0) ? Math.round(indent / 24) : 0,
        lineHeight: (lineHeight > 0) ? lineHeight : null,
      };
    }
    function _alignIndentAttrs(node) {
      var style = '';
      if (node.attrs.align && node.attrs.align !== 'left') style += 'text-align:' + node.attrs.align + ';';
      if (node.attrs.indent) style += 'margin-left:' + (node.attrs.indent * 24) + 'px;';
      if (node.attrs.lineHeight) style += 'line-height:' + node.attrs.lineHeight + ';';
      return style ? { style: style } : {};
    }
    // list_item's own toDOM attrs: indent (via _alignIndentAttrs) plus the
    // checklist state. `checked` is null for ordinary bullet/numbered items,
    // true/false only for checklist items that have been toggled.
    function _listItemAttrs(node) {
      var attrs = _alignIndentAttrs(node);
      if (node.attrs.checked !== null && node.attrs.checked !== undefined) {
        attrs['data-checked'] = node.attrs.checked ? 'true' : 'false';
      }
      return attrs;
    }
    function _parseListItem(dom) {
      var attrs = _parseAlignIndent(dom);
      var checked = dom.getAttribute && dom.getAttribute('data-checked');
      return { indent: attrs.indent, checked: checked === 'true' ? true : checked === 'false' ? false : null };
    }

    // Shared by link_preview_card's two parseDOM tag matchers (div for the
    // embed variant, a for the static card — see that node spec's comment).
    function _getLinkPreviewCardAttrs(d) {
      var rawBluesky = d.getAttribute('data-bluesky');
      var bluesky = null;
      if (rawBluesky) { try { bluesky = JSON.parse(rawBluesky); } catch (e) { bluesky = null; } }
      return { url: d.getAttribute('data-url'), title: d.getAttribute('data-title'),
               description: d.getAttribute('data-description'),
               image: d.getAttribute('data-image'), siteName: d.getAttribute('data-site-name'),
               provider: d.getAttribute('data-provider'), embedUrl: d.getAttribute('data-embed-url'),
               bluesky: bluesky };
    }

    var PostCardEditorClass = lively.morphic.Box.subclass('lively.identity.PostCardEditor',

    // ─── serialization guard ──────────────────────────────────────────────────────

    'serialization', {
      doNotSerialize: ['editorView', 'yDoc', 'wsProvider', '_saveTimer', '_pmContainer', '_previewEl', '_contentLoadStarted', '_backBar', '_backDiv', '_backFace', '_stampLayer', '_stampEls',
        '_saveInFlight', '_saveRerun', '_saveWaiters', '_pendingPrefill'],
    },

    // ─── initialization ──────────────────────────────────────────────────────────

    'initialization', {

      // No initialize override — Lively's Morph.initialize sets up submorphs etc.
      // State is set directly in newCard/openCard before _setup() is called.

      // Called after the morph is in the world and DOM is available. Also
      // re-invoked by prepareForNewRenderContext below after a world
      // save/reload restores this morph — none of the DOM _buildChrome
      // builds (toolbar, pmDiv, etc.) survives serialization, so without
      // that it would come back as a blank shell.
      _setup: function () {
        // This morph is meant to live inside a lively.morphic.Window (see
        // openCard/newCard) whose title bar is the drag handle — without this,
        // Lively's default whole-body dragging (Events.js) intercepts mousedown
        // on pmDiv before native text-selection drag ever gets a chance, so
        // trying to drag-select text drags the whole editor instead.
        this.disableDragging();
        this.disableGrabbing();
        this._envelope = null;
        this.editorView = null;
        this.yDoc = null;
        this.wsProvider = null;
        this._saveTimer = null;
        this._pmContainer = null;
        this._statusLabel = null;
        this._statusEl = null;
        this._toolbarDiv = null;
        // Public/Private toggle — 'shared' is not a distinct editor-side state,
        // it's what serializeEncrypted derives automatically once there is
        // someone to seal to.
        this._visibility = 'public';
        // Who a private card is sealed to is either its recorded audience
        // (_audience = { tiers, people }, kept in the owner's settings; expanded
        // against the current friends/orbit/lists at every save) or, for a card
        // shared before audiences existed, the flat handle list below.
        this._audience = null;
        this._audienceLoaded = false;   // the recorded audience has been read (needed before any private save of an existing card)
        this._audienceDirty = false;    // chosen before the card had an objId; recorded after its first save
        this._audienceCtx = null;
        this._audienceCtxAt = 0;
        this._recipientHandles = [];
        this._extraRecipientHandles = []; // sealed to as well, for the duration of a Send
        this._lastSealedHandles = [];
        this._grantedAttachments = {};
        this._sentLocked = false;       // delivered to an inbox: permanent, no further edits
        this._visibilityBtn = null;
        this._title = '';               // explicit, unencrypted title (private/shared cards; see _buildTitleRow)
        this._titleChangePending = false;
        this._titleRow = null;
        this._titleInput = null;
        this._titleNote = null;
        this._quietBtn = null;
        this._quietEdit = false;        // this editing session's saves ask readers not to be notified (state.editMinor)
        // Attachment metadata (§6): { objId, dek, blobCid, blobNonce, name,
        // mime } entries — pass-through inside the postcard payload, hydrated
        // from the loaded envelope in _loadExistingNow.
        this._attachments = [];
        // Back-of-card stamps: [{ objId, x, y, w, ar }] — objId resolves
        // against _attachments (same dek/blobCid pass-through as inline
        // images), x/y/w are fractions of the back face (see PostCardView's
        // _renderBackStamps), ar is natural width/height. Plain mode only.
        this._backStamps = [];
        // Game block ({ title, cover_url, igdb_id, status, rating?, playtime_minutes?,
        // playtime_source? }) when this card shares a game from the Gaming template, else
        // null. Carried inside the payload as payload.game, and flagged in the readable
        // state as hasGame (the flag says THAT a game is attached, never which). Seeded
        // from the loaded payload in _loadExistingNow's _onDeserialized, like _backStamps,
        // because the save params are rebuilt from editor fields each time.
        this._game = null;
        this._backViewActive = false;
        this._selectedStampIdx = -1;
        // Plain-mode-only (§1.1/§2.3): { embedId: {...plain JSON...} },
        // this card's counterpart to a wiki-mode card's yDoc.getMap('partState').
        // Set fresh in _createNewDoc for a new plain card, hydrated from
        // payload.partState in _loadExistingNow for an existing one. Unused
        // in wiki mode. _plainDoc briefly holds a loaded card's ProseMirror
        // JSON between deserialization and _attachEditor seeding the actual
        // editor state from it — nulled out once consumed.
        this._partState = null;
        this._plainDoc = null;
        // Optional location tag (a floored, <=6-significant-digit Plus
        // Code — see PostCardUtils.js's encodeLocation). _locationCleared
        // distinguishes "never attached one" (both null) from "explicitly
        // removed" (code null, cleared true) — a save must be able to send
        // stateMeta.location: null on removal rather than just omitting the
        // field, or the server can't tell "no change" from "clear it."
        this._locationCode = null;
        this._locationCleared = false;
        this._locationBtn = null;
        // Sender-controlled opt-out toggle (PostcardDesignSpec-v2.md §5.4) —
        // defaults on. Seeded from the loaded envelope in _loadExistingNow,
        // same pattern as _locationCode above. No compose UI yet (reverted —
        // broke the editor's typability, see chat history) — this currently
        // just carries each card's default through save/reload unchanged.
        this._reactionsEnabled = true;
        // True for a new card (you're creating it) or once _loadExistingNow
        // compares envelope.did to the session DID. Gates Send and the
        // visibility toggle specifically (those stay owner-only even for a
        // wiki page a non-owner member can edit — see _canEdit below for
        // the check that actually gates editing/Save).
        this._isOwner = true;
        // Whether THIS session may edit/save this card at all. Equals
        // _isOwner for every plain card (owner-only, unconditionally,
        // §1.1) and for a new/not-yet-loaded card. For a loaded wiki-mode
        // card (§1.2/§16.6) a non-owner may still have write access via
        // constellation membership — _loadExistingNow resolves that
        // asynchronously (one extra GET .../space-token round trip, only
        // for this one case) before finalizing this flag. Read by
        // _applyReadOnlyMode and _markEdited; _isOwner alone would
        // otherwise force every non-owner into read-only, even one the
        // server-side PUT route (IdentityServer.js) would actually accept
        // a write from.
        this._canEdit = true;
        // _isWikiMode no longer means "this is a wiki page" — wiki pages
        // are type:'wikipage' now and never reach this editor at all (see
        // WikiEditor.js). It's kept purely as a legacy-payload-format flag:
        // some pre-split type:'postcard' rows still have payload.format
        // 'yjs-update-v1' (confirmed still present in the dev DB) and must
        // keep loading/saving via the Yjs pair they were written with — no
        // migration/backfill. Always false for a brand-new card; only
        // _loadExistingNow (reading the actual stored format) can set it
        // true, for an existing legacy card.
        this._isWikiMode = false;
        this._buildChrome();

        // Guards against double-firing the async content-load dispatch
        // below. _setup() can legitimately be entered twice for the same
        // genesis attempt: openCard/newCard call it explicitly right after
        // opening this morph in a window, but attaching to that window's
        // new render context *also* triggers prepareForNewRenderContext
        // below (Rendering.js's replaceRenderContextWith/renderAfterUsing
        // call it on any morph acquiring a new render context) — and by
        // then _handle is already set, so its own guard doesn't skip it.
        // Without this, _createNewDoc() (or _loadExisting()) runs twice:
        // two independent Y.Docs each get their own ProseMirror EditorView,
        // both eventually mounted against whatever _pmContainer is current
        // when their async setup resolves — two overlapping editor views,
        // two autosaved genesis objIds, and an editor that silently stops
        // accepting focus/typing. _contentLoadStarted is doNotSerialize'd
        // so a genuine future restore (a real new page load reconstructing
        // this morph from a saved world) still starts falsy and runs
        // _loadExisting() as before — this guard is only ever meant to
        // suppress a same-turn duplicate call, not a legitimate later one.
        if (this._contentLoadStarted) return;
        this._contentLoadStarted = true;
        if (this._isNew) {
          this._createNewDoc();
        } else {
          this._loadExisting();
        }
      },

      // Fires once, harmlessly, during construction — before openCard/
      // newCard have set _handle, so the guard below skips it (those
      // factories call _setup() themselves once configured). Fires again,
      // recursively for every submorph in the world, whenever a saved world
      // is reloaded (see Rendering.js's prepareForNewRenderContext) or this
      // morph is copied — _handle/_objId/_isNew are plain
      // fields and survive serialization fine, but the DOM _buildChrome
      // builds does not, so without this a restored editor comes back
      // blank. Matches the identical fix in PostCardView.js. Also fires as
      // an *immediate* same-turn duplicate of openCard/newCard's own
      // explicit _setup() call, when attaching this morph to its new
      // window triggers a render-context change — see _setup()'s own
      // _contentLoadStarted guard for why that's safe.
      prepareForNewRenderContext: function ($super, renderCtx) {
        $super(renderCtx);
        if (!this._handle) return;
        this._setup();
      },

    },

    // ─── chrome (UI scaffolding) ─────────────────────────────────────────────────

    'chrome', {

      // Total height of the two-row formatting toolbar (Row A: marks + font
      // controls; Row B: block-level commands — Location/status/Send/Save
      // live in a separate floating cluster, not in the toolbar, see
      // _buildFloatingActions). Kept as a named constant since pmDiv's own
      // top offset has to stay in sync with it (see _buildChrome/pmDiv below).
      _TOOLBAR_HEIGHT: 70,

      // The title row under the toolbar, shown for a private or shared card only (a
      // public card's title is its first line). pmDiv's top offset follows it.
      _TITLE_ROW_HEIGHT: 84,

      // Reserved bottom padding on pmDiv so real content never renders
      // underneath the floating action cluster (which hovers over the
      // content area rather than reserving its own docked strip).
      _FLOATING_ACTIONS_CLEARANCE: 72,

      // Base text size (px) of the editing area and preview overlay, and what
      // the font-size stepper shows when the selection carries no explicit
      // fontSize mark (choosing this size clears the mark instead of storing it).
      _DEFAULT_FONT_SIZE: 20,

      _buildChrome: function () {
        var self = this;
        this.setFill(Color.white);

        var shapeNode = this.renderContext().shapeNode;
        shapeNode.innerHTML = ''; // idempotent: safe if _setup() ever runs twice on one instance
        // Set the radius on the morph model, not just the DOM node: a Window
        // collapse/expand detaches and re-adds this morph, which re-runs the
        // shape's initHTML and re-applies the model's borderRadius (0),
        // wiping a style written only onto the shapeNode.
        this.setBorderRadius(10);
        shapeNode.style.borderRadius = '10px';
        shapeNode.style.boxShadow = '0 4px 14px rgba(0,0,0,0.16)';
        // Rounded corners are otherwise decorative-shadow-only: toolbarDiv/
        // pmDiv are flush square rectangles exactly covering shapeNode's own
        // edges, so without clipping them to this radius the content
        // underneath still renders square. The link-preview popup
        // (_buildLinkPreview) is the one absolutely-positioned child that
        // could theoretically clip here if it ever rendered flush against an
        // edge — in practice it's positioned just below a link inside the
        // padded content area, well clear of the outer edge.
        shapeNode.style.overflow = 'hidden';

        // Toolbar as a plain DOM div — keeping it out of Lively's morph hierarchy
        // prevents Lively from grabbing the toolbar as an independent draggable morph.
        // This morph's own body-dragging is disabled (_setup) — drag via the
        // enclosing lively.morphic.Window's title bar instead (openCard/newCard).
        var toolbarDiv = document.createElement('div');
        toolbarDiv.style.cssText = [
          'position:absolute',
          'top:0',
          'left:0',
          'right:0',
          'height:' + this._TOOLBAR_HEIGHT + 'px',
          'background:#fff',
          'border-bottom:1px solid #eee',
          'box-sizing:border-box',
          'overflow:hidden',
        ].join(';');
        shapeNode.appendChild(toolbarDiv);
        this._toolbarDiv = toolbarDiv;
        this._buildToolbar(toolbarDiv);

        this._buildLinkPreview(shapeNode);
        this._buildTitleRow(shapeNode);

        // ProseMirror container div. The 'selectable' class matters, not just
        // cosmetically: Lively's global base stylesheet (Main.js) sets
        // `*:not(:focus) { user-select: none }` on everything by default (to
        // stop drag-selecting morph contents), with `.selectable, .selectable *`
        // as the opt-out. ProseMirror's own contenteditable node and its text
        // content are descendants of pmDiv, not pmDiv itself, and never match
        // `:focus` individually — without this class, native browser text
        // selection/caret operations over that content (notably Backspace/
        // Delete, which ProseMirror deliberately leaves to native contenteditable
        // handling — see prosemirror-view's captureKeyDown) silently don't work.
        var pmDiv = document.createElement('div');
        pmDiv.className = 'lively-postcard-editor-container selectable';
        pmDiv.style.cssText = [
          'position:absolute',
          'top:' + this._TOOLBAR_HEIGHT + 'px',
          'left:0',
          'right:0',
          'bottom:0',
          'overflow-y:auto',
          'padding:16px 20px ' + this._FLOATING_ACTIONS_CLEARANCE + 'px 20px',
          'box-sizing:border-box',
          'font-family:sans-serif',
          'font-size:' + this._DEFAULT_FONT_SIZE + 'px',
          'line-height:1.6',
          'white-space:pre-wrap',
        ].join(';');
        shapeNode.appendChild(pmDiv);
        this._pmContainer = pmDiv;
        this._updateTitleRow();

        // Back-of-card stamp arranger (hidden until _showBackView) — a plain
        // DOM sibling of pmDiv, same event-isolation treatment below.
        this._buildBackView(shapeNode);

        // Floating action cluster (Location/status/Send/Save) — appended
        // after pmDiv so it paints on top in source order, hovering over
        // the bottom-right of the content area (see the reserved bottom
        // padding on pmDiv just above).
        this._buildFloatingActions(shapeNode);

        if (!document.getElementById('lively-postcard-editor-style')) {
          var styleEl = document.createElement('style');
          styleEl.id = 'lively-postcard-editor-style';
          styleEl.textContent =
            '.lively-postcard-editor-container .ProseMirror > :first-child {' +
            '  font-size:20px;font-weight:bold;margin-bottom:8px;' +
            '}' +
            '.lively-postcard-image{max-width:100%;max-height:320px;vertical-align:middle;' +
            'border-radius:4px;}' +
            '.lively-postcard-video{display:block;width:100%;max-height:480px;object-fit:contain;background:#000;border-radius:4px;}' +
            '.lively-postcard-audio{max-width:100%;width:320px;display:block;}' +
            '.lively-math-node{cursor:pointer;border-radius:3px;}' +
            '.lively-math-node.lively-math-selected,' +
            '.lively-math-node.ProseMirror-selectednode{outline:2px solid #8cf;}' +
            '.lively-math-node.math-inline{padding:0 2px;}' +
            '.lively-math-node.math-display{display:block;padding:8px;text-align:center;}' +
            '.lively-math-empty{color:#999;font-style:italic;border:1px dashed #ccc;padding:0 4px;}' +
            '.lively-math-error{color:#c33;border:1px dashed #c33;padding:0 4px;}' +
            '.lively-math-input{font-family:monospace;font-size:13px;border:1px solid #55c;' +
            'border-radius:3px;padding:2px 4px;}' +
            'input.lively-math-input{min-width:80px;}' +
            'textarea.lively-math-input{width:100%;min-height:48px;box-sizing:border-box;}' +
            '.lively-embedded-part-node{position:relative;min-height:32px;margin:4px 0;' +
            'border:1px solid #ddd;border-radius:4px;overflow:hidden;}' +
            '.lively-embedded-part-content{padding:4px;}' +
            '.lively-embedded-part-content.lively-embed-error{color:#c33;font-style:italic;padding:8px;}' +
            '.lively-embed-overlay{position:absolute;top:2px;right:2px;display:flex;gap:4px;z-index:10;}' +
            '.lively-embed-overlay button{font-size:10px;padding:2px 6px;cursor:pointer;' +
            'border:1px solid #ccc;border-radius:3px;background:#fff;}' +
            '.lively-embed-overlay button.lively-embed-remove-btn{border-color:#c33;color:#c33;}' +
            // ── modern chrome (pce = PostCardEditor): action pills, icon
            // buttons, restyled inputs — one accent (#E31361) reused
            // everywhere so the whole editor reads as one system. See also
            // PostCardEditorClass._ensureAccentChromeCss for the matching
            // window-title-bar accent (same hex).
            '.pce-icon-btn{flex:0 0 auto;display:flex;align-items:center;justify-content:center;' +
            'width:28px;height:28px;padding:0;box-sizing:border-box;border:none;border-radius:50%;' +
            'background:transparent;color:#555;cursor:pointer;transition:background .15s,color .15s;}' +
            '.pce-icon-btn.pce-icon-btn-glyph{font-family:"Material Symbols Rounded";font-size:17px;line-height:1;}' +
            '.pce-icon-btn:hover{background:#f0f0f5;color:#222;}' +
            '.pce-icon-btn.pce-icon-btn-accent,.pce-icon-btn.pce-icon-btn-accent:hover{color:#E31361;}' +
            '.pce-icon-btn.pce-icon-btn-accent:hover{background:#fde6ee;}' +
            '.pce-icon-btn.pce-active{background:#fde6ee;color:#E31361;}' +
            '.pce-icon-btn.pce-active:hover{background:#fbd0e0;}' +
            '.pce-pill-btn{flex:0 0 auto;display:flex;align-items:center;gap:4px;height:26px;' +
            'padding:0 10px;box-sizing:border-box;font-size:12px;font-family:sans-serif;' +
            'font-weight:600;border-radius:13px;cursor:pointer;transition:background .15s,' +
            'border-color .15s,color .15s;}' +
            '.pce-pill-btn .pce-pill-glyph{font-family:"Material Symbols Rounded";font-size:15px;' +
            'line-height:1;font-weight:400;}' +
            '.pce-pill-neutral{background:#fff;border:1px solid #ddd;color:#444;}' +
            '.pce-pill-neutral:hover{background:#f6f6f9;}' +
            '.pce-pill-accent-soft{background:#fde6ee;border:1px solid #f6b8cf;color:#c8105a;}' +
            '.pce-pill-accent-soft:hover{background:#fbd0e0;}' +
            '.pce-pill-solid{background:#E31361;border:1px solid #E31361;color:#fff;}' +
            '.pce-pill-solid:hover{background:#c90f54;}' +
            '.pce-status-text{flex:0 0 auto;font-size:10px;color:#999;font-family:sans-serif;' +
            'pointer-events:none;max-width:110px;overflow:hidden;text-overflow:ellipsis;' +
            'white-space:nowrap;}' +
            '.pce-input-control{flex:0 0 auto;height:26px;box-sizing:border-box;border:1px solid #ddd;' +
            'border-radius:8px;background:#fff;cursor:pointer;font-size:11px;}' +
            '.pce-size-stepper{flex:0 0 auto;display:flex;align-items:center;gap:0;}' +
            '.pce-icon-btn.pce-step-btn{width:22px;height:22px;font-size:16px;}' +
            '.pce-input-control.pce-size-input{width:34px;padding:0 2px;text-align:center;' +
            'border-color:transparent;background:transparent;-moz-appearance:textfield;}' +
            '.pce-size-input::-webkit-inner-spin-button,.pce-size-input::-webkit-outer-spin-button' +
            '{-webkit-appearance:none;margin:0;}' +
            '.pce-input-control:hover{border-color:#ccc;}' +
            '.pce-input-control:focus{border-color:#E31361;outline:none;}' +
            // Floating action cluster — a small rounded, shadowed capsule
            // hovering over the bottom-right of the content area (Notion-
            // style), not a docked footer strip. Needs its own border since
            // it sits on the same white as the content beneath it.
            '.pce-floating-actions{position:absolute;right:14px;bottom:14px;display:flex;' +
            'align-items:center;gap:8px;background:#fff;border:1px solid #eee;border-radius:20px;' +
            'padding:6px 10px;box-shadow:0 4px 14px rgba(0,0,0,0.16);z-index:6;}' +
            '.pce-floating-actions.pce-floating-actions-left{right:auto;left:14px;gap:2px;padding:4px 6px;}' +
            // Content area's own scrollbar (the only scrollbar left in the
            // editor now that the toolbar rows no longer scroll) — tinted to
            // match the accent instead of a plain OS-gray bar. Webkit
            // pseudo-elements for Chrome/Edge, scrollbar-color/-width as the
            // standard-CSS fallback (Firefox).
            '.lively-postcard-editor-container{scrollbar-color:#f6b8cf transparent;' +
            'scrollbar-width:thin;}' +
            '.lively-postcard-editor-container::-webkit-scrollbar{width:10px;}' +
            '.lively-postcard-editor-container::-webkit-scrollbar-track{background:transparent;}' +
            '.lively-postcard-editor-container::-webkit-scrollbar-thumb{background:#f6b8cf;' +
            'border-radius:6px;border:2px solid transparent;background-clip:padding-box;}' +
            '.lively-postcard-editor-container::-webkit-scrollbar-thumb:hover{background:#E31361;' +
            'background-clip:padding-box;}' +
            // Font-family dropdown: the native <select> popup can't have its
            // scrollbar styled, so opt into the customizable-select picker
            // (a real DOM popup) where supported and give it the same light-
            // pink scrollbar as the content area. Browsers without
            // base-select keep the plain native dropdown, with the
            // scrollbar-color hint applied anyway.
            'select.pce-input-control{scrollbar-color:#f6b8cf transparent;scrollbar-width:thin;}' +
            '@supports (appearance:base-select){' +
            'select.pce-input-control,select.pce-input-control::picker(select){appearance:base-select;}' +
            'select.pce-input-control{align-items:center;justify-content:center;line-height:1;}' +
            'select.pce-input-control::picker(select){max-height:300px;padding:4px;background:#fff;' +
            'border:1px solid #ddd;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,0.16);' +
            'scrollbar-color:#f6b8cf transparent;scrollbar-width:thin;}' +
            'select.pce-input-control option{padding:3px 8px;border-radius:5px;font-size:13px;color:#222;}' +
            'select.pce-input-control option:hover,select.pce-input-control option:focus{background:#fde6ee;}' +
            'select.pce-input-control option:checked{background:#f6b8cf;}' +
            'select.pce-input-control option::checkmark{display:none;}' +
            '}' +
            '.lively-link-preview-node{margin:4px 0;border-radius:8px;}' +
            '.lively-link-preview-node.lively-link-preview-node-selected,' +
            '.lively-link-preview-node.ProseMirror-selectednode{outline:2px solid #8cf;}';
          document.head.appendChild(styleEl);
        }

        // Stop keyboard and mouse events from bubbling up to Lively's morph handlers.
        // Bubble phase only — capture phase would block events from reaching PM's div inside pmDiv.
        ['keydown', 'keyup', 'keypress', 'input'].forEach(function (t) {
          pmDiv.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick'].forEach(function (t) {
          pmDiv.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        [this._backDiv, this._backBar].forEach(function (el) {
          ['keydown', 'keyup', 'keypress', 'input', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick'].forEach(function (t) {
            el.addEventListener(t, function (e) { e.stopPropagation(); });
          });
        });
      },

      // Two formatting rows, each a plain strip of icon-only circular
      // buttons (Material Symbols Rounded glyphs — see CLAUDE.md's icon
      // convention). Card-level actions (Location/status/Send/Save) live in
      // a separate floating pill cluster over the content area instead
      // (_buildFloatingActions, called from _buildChrome) — keeping them
      // out of here is what lets both rows comfortably fit their own
      // content at the window's normal width with no scrollbar: Row A's 9
      // marks + 4 font/color controls measure ~465px and Row B's 14 blocks
      // measure ~445px, both well under the ~650-660px available.
      _buildToolbar: function (toolbarDiv) {
        var self = this;

        // Row 1: the everyday word-processor controls, in the order a writer
        // reaches for them — the Styles/Font/Size/List/Line-height controls
        // are built by their own _build*Select/Input helpers below and
        // interleaved with these icon-button groups.
        var emphasisDefs = [
          { icon: 'format_bold',       title: 'Bold',              cmd: 'toggleMark', markType: 'bold' },
          { icon: 'format_italic',     title: 'Italic',            cmd: 'toggleMark', markType: 'italic' },
          { icon: 'format_underlined', title: 'Underline',         cmd: 'toggleMark', markType: 'underline' },
        ];
        var insertDefs = [
          { icon: 'link',              title: 'Insert/remove link', cmd: 'link' },
          { icon: 'attach_file',       title: 'Upload attachment',  cmd: 'attachment' },
        ];
        var alignDefs = [
          { icon: 'format_align_left',    title: 'Align left',   cmd: 'setAlign', align: 'left' },
          { icon: 'format_align_center',  title: 'Align center', cmd: 'setAlign', align: 'center' },
          { icon: 'format_align_right',   title: 'Align right',  cmd: 'setAlign', align: 'right' },
          { icon: 'format_align_justify', title: 'Justify',      cmd: 'setAlign', align: 'justify' },
        ];

        // "Everything else", in order, each array one divider-separated
        // cluster. The toolbar is one ordered sequence that simply wraps
        // from Row 1 onto Row 2 where Row 1 runs out of room.
        var extraMarkDefs = [
          { icon: 'strikethrough_s',        title: 'Strikethrough',      cmd: 'toggleMark', markType: 'strike' },
          { icon: 'superscript',            title: 'Superscript',        cmd: 'toggleMark', markType: 'superscript' },
          { icon: 'subscript',              title: 'Subscript',          cmd: 'toggleMark', markType: 'subscript' },
        ];
        var blockDefs = [
          { icon: 'format_quote',           title: 'Blockquote',         cmd: 'wrapIn',       nodeType: 'blockquote' },
          { icon: 'code_blocks',            title: 'Code block',         cmd: 'setBlockType', nodeType: 'code_block', attrs: {} },
          { icon: 'code',                   title: 'Inline code',        cmd: 'toggleMark', markType: 'code' },
        ];
        var indentDefs = [
          { icon: 'format_indent_increase', title: 'Indent',             cmd: 'indent' },
          { icon: 'format_indent_decrease', title: 'Outdent',            cmd: 'outdent' },
          { icon: 'format_clear',           title: 'Clear formatting',   cmd: 'clearFormatting' },
        ];
        var embedDefs = [
          { icon: 'extension',              title: 'Insert part',        cmd: 'insertPart' },
          { icon: 'functions',              title: 'Math inline',        cmd: 'insertMath', mathType: 'inline' },
          { icon: 'calculate',              title: 'Math display',       cmd: 'insertMath', mathType: 'display' },
        ];

        // Plain full-width row, no scrolling — both rows' content comfortably
        // fits the toolbar's available width at the window's normal size (see
        // comment above), so overflow:hidden is just a safety net for an
        // unusually narrow resize (silent clip, never a scrollbar) rather
        // than something expected to actually engage in normal use.
        function buildRow(top, height) {
          var row = document.createElement('div');
          row.style.cssText = [
            'position:absolute', 'top:' + top + 'px', 'left:6px', 'right:6px', 'height:' + height + 'px',
            'display:flex', 'align-items:center', 'justify-content:flex-start', 'gap:6px', 'padding:0 4px',
            'overflow:hidden', 'white-space:nowrap',
          ].join(';');
          toolbarDiv.appendChild(row);
          return row;
        }

        // Thin vertical rule separating one cluster of controls from the next.
        function addDivider(row) {
          var d = document.createElement('div');
          d.style.cssText = 'flex:0 0 auto;width:1px;height:18px;background:#e6e6ec;margin:0 4px;';
          row.appendChild(d);
        }

        this._toggleButtons = [];

        function addButtons(row, defs) {
          defs.forEach(function (btnDef) {
            var btn = document.createElement('button');
            btn.className = 'pce-icon-btn pce-icon-btn-glyph' + (btnDef.accent ? ' pce-icon-btn-accent' : '');
            btn.textContent = btnDef.icon;
            btn.title = btnDef.title;
            btn.addEventListener('mousedown', function (e) {
              e.preventDefault();
              e.stopPropagation();
              self._execToolbarCmd(btnDef);
            });
            row.appendChild(btn);
            if (btnDef.cmd === 'toggleMark') {
              self._toggleButtons.push({ btn: btn, markType: btnDef.markType });
            }
            if (btnDef.cmd === 'setAlign') {
              self._alignButtons.push({ btn: btn, align: btnDef.align });
            }
          });
        }

        this._alignButtons = [];

        var ROW_H = 30;
        var rowA = buildRow(3, ROW_H);
        // Row 1 is shorter than Row 2, which sets the editor's width — spread
        // its controls so it spans the same width instead of leaving a gap.
        rowA.style.justifyContent = 'space-between';
        // Row 1: style, size, font | B I U | colors | align.
        this._styleSelect = this._buildStyleSelect();
        rowA.appendChild(this._styleSelect);
        rowA.appendChild(this._buildFontSizeInput()); // also sets this._fontSizeInput
        this._fontFamilySelect = this._buildFontFamilySelect();
        rowA.appendChild(this._fontFamilySelect);
        addDivider(rowA);
        addButtons(rowA, emphasisDefs);
        addDivider(rowA);
        this._textColorInput = this._buildColorInput('textColor', 'Text color', '#000000');
        rowA.appendChild(this._textColorInput);
        this._bgColorInput = this._buildColorInput('backgroundColor', 'Highlight color', '#ffffff');
        rowA.appendChild(this._bgColorInput);
        addDivider(rowA);
        addButtons(rowA, alignDefs);

        // Row 2: link, upload | line height, list | marks | quote, code
        // block, inline code | indent, outdent, clear | part, math.
        var rowB = buildRow(3 + ROW_H + 3, ROW_H);
        addButtons(rowB, insertDefs);
        addDivider(rowB);
        this._lineHeightSelect = this._buildLineHeightSelect();
        rowB.appendChild(this._lineHeightSelect);
        this._listSelect = this._buildListSelect();
        rowB.appendChild(this._listSelect);
        addDivider(rowB);
        addButtons(rowB, extraMarkDefs);
        addDivider(rowB);
        addButtons(rowB, blockDefs);
        addDivider(rowB);
        addButtons(rowB, indentDefs);
        addDivider(rowB);
        addButtons(rowB, embedDefs);
      },

      // Styles dropdown: Normal text + Heading 1–6. Applies to every
      // paragraph/heading in the selection (see 'setBlockStyle' in
      // _execToolbarCmd); reflects the cursor's block in _updateToolbarState.
      _buildStyleSelect: function () {
        var self = this;
        var select = document.createElement('select');
        select.className = 'pce-input-control';
        select.title = 'Styles';
        select.style.cssText = 'width:112px;padding:0 6px;justify-content:flex-start;';
        [['', 'Styles'], ['p', 'Normal text'], ['1', 'Heading 1'], ['2', 'Heading 2'], ['3', 'Heading 3'],
         ['4', 'Heading 4'], ['5', 'Heading 5'], ['6', 'Heading 6']].forEach(function (opt) {
          var optionEl = document.createElement('option');
          optionEl.value = opt[0];
          optionEl.textContent = opt[1];
          // The empty option is only a read-only "cursor is in something else"
          // placeholder (e.g. a code block), never a choosable action.
          if (!opt[0]) optionEl.disabled = true;
          select.appendChild(optionEl);
        });
        ['mousedown', 'click'].forEach(function (t) {
          select.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        select.addEventListener('change', function () {
          if (!select.value) return;
          self._execToolbarCmd({ cmd: 'setBlockStyle', style: select.value });
        });
        return select;
      },

      // Line height dropdown — a per-block preset (stored as the
      // paragraph/heading `lineHeight` attr), '' = the editor's default.
      _buildLineHeightSelect: function () {
        var self = this;
        var select = document.createElement('select');
        select.className = 'pce-input-control';
        select.title = 'Line height';
        select.style.cssText = 'width:112px;padding:0 6px;justify-content:flex-start;';
        [['', 'Line height'], ['1', '1.0'], ['1.15', '1.15'], ['1.5', '1.5'], ['2', '2.0'], ['2.5', '2.5']]
          .forEach(function (opt) {
            var optionEl = document.createElement('option');
            optionEl.value = opt[0];
            // The '' entry doubles as "reset to the editor's default".
            optionEl.textContent = opt[1];
            select.appendChild(optionEl);
          });
        ['mousedown', 'click'].forEach(function (t) {
          select.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        select.addEventListener('change', function () {
          self._execToolbarCmd({ cmd: 'setLineHeight', lineHeight: select.value ? parseFloat(select.value) : null });
        });
        return select;
      },

      // List dropdown: a command menu (always resets to its "List"
      // placeholder after acting), not a state display — whether the cursor
      // is already in a list shows through the options' toggle behavior.
      _buildListSelect: function () {
        var self = this;
        var select = document.createElement('select');
        select.className = 'pce-input-control';
        select.title = 'List';
        select.style.cssText = 'width:96px;padding:0 6px;justify-content:flex-start;';
        [['', 'List'], ['bullet_list', 'Bullet list'], ['ordered_list', 'Numbered list'],
         ['check_list', 'Checklist'], ['none', 'Remove list']].forEach(function (opt) {
          var optionEl = document.createElement('option');
          optionEl.value = opt[0];
          optionEl.textContent = opt[1];
          if (!opt[0]) { optionEl.disabled = true; optionEl.selected = true; }
          select.appendChild(optionEl);
        });
        ['mousedown', 'click'].forEach(function (t) {
          select.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        select.addEventListener('change', function () {
          var value = select.value;
          select.value = '';
          if (value) self._execToolbarCmd({ cmd: 'setList', listType: value });
        });
        return select;
      },

      // Persistent (not popup-triggered) native color input — reflects the
      // current selection's color (_updateToolbarState) and applies on pick.
      _buildColorInput: function (markName, title, fallback) {
        var self = this;
        var input = document.createElement('input');
        input.type = 'color';
        input.className = 'pce-input-control';
        input.title = title;
        input.value = fallback;
        input.style.cssText = 'width:26px;padding:0;';
        ['mousedown', 'click'].forEach(function (t) {
          input.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        input.addEventListener('input', function () {
          if (!self.editorView) return;
          var view = self.editorView;
          var markType = view.state.schema.marks[markName];
          if (!markType) return;
          var from = view.state.selection.from, to = view.state.selection.to;
          if (from === to) return; // requires a text selection
          view.dispatch(view.state.tr.addMark(from, to, markType.create({ color: input.value })));
        });
        input.addEventListener('change', function () { if (self.editorView) self.editorView.focus(); });
        return input;
      },

      _buildFontFamilySelect: function () {
        var self = this;
        // [css value, label, preview font-family]
        var options = [
          ['sans-serif', 'Sans', 'sans-serif'],
          ['serif', 'Serif', 'serif'],
          ['monospace', 'Mono', 'monospace'],
          ['"Comic Sans MS", cursive', 'Comic', '"Comic Sans MS", cursive'],
          ['Georgia, serif', 'Georgia', 'Georgia, serif'],
        ];
        // Vendored Google Fonts (core/styles/google-fonts.css, loaded once per
        // world by StyleSheets.js) — same list the TextFormattingToolbar's font
        // picker uses. Merged into one alphabetical list with the generic
        // faces; each option previews in its own face.
        var NS = lively.morphic.TextFormattingToolbar;
        var vendored = (NS && NS.VENDORED_FONT_NAMES) || [];
        vendored.forEach(function (name) {
          var css = "'" + name + "', sans-serif";
          options.push([css, name, css]);
        });
        options.sort(function (a, b) {
          return a[1].toLowerCase() < b[1].toLowerCase() ? -1 : a[1].toLowerCase() > b[1].toLowerCase() ? 1 : 0;
        });
        options.unshift(['', 'Font', '']);
        var select = document.createElement('select');
        select.className = 'pce-input-control';
        select.title = 'Font family';
        // Fixed width, with the selected name clipped (ellipsis) rather than
        // overflowing into the neighboring controls — some vendored font
        // names are long ("Shadows Into Light Two").
        select.style.cssText = 'width:160px;padding:0 6px;justify-content:flex-start;' +
          'overflow:hidden;white-space:nowrap;text-overflow:ellipsis;';
        options.forEach(function (opt) {
          var optionEl = document.createElement('option');
          optionEl.value = opt[0];
          optionEl.textContent = opt[1];
          if (opt[2]) optionEl.style.fontFamily = opt[2];
          select.appendChild(optionEl);
        });
        // @font-face resources are fetched lazily; kick them off now so the
        // dropdown previews and applied text don't flash a fallback face.
        if (NS && NS.warmVendoredFonts) NS.warmVendoredFonts();
        ['mousedown', 'click'].forEach(function (t) {
          select.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        select.addEventListener('change', function () {
          if (!self.editorView) return;
          var view = self.editorView;
          var markType = view.state.schema.marks.fontFamily;
          if (!markType) return;
          var from = view.state.selection.from, to = view.state.selection.to;
          if (from === to) return; // requires a text selection
          var tr = view.state.tr.removeMark(from, to, markType);
          if (select.value) tr = tr.addMark(from, to, markType.create({ family: select.value }));
          view.dispatch(tr);
          view.focus();
        });
        return select;
      },

      // Font-size stepper: [ − ] [ 20 ] [ + ]. The middle field is still
      // directly editable (type a size + Enter/blur); − and + step by 1px.
      // Returns the wrapper to insert in the toolbar; this._fontSizeInput is
      // the inner input (what _updateToolbarState writes the current size
      // into — the default size when the selection has no fontSize mark).
      _buildFontSizeInput: function () {
        var self = this;
        var DEFAULT = this._DEFAULT_FONT_SIZE, MIN = 6, MAX = 128;

        var wrap = document.createElement('div');
        wrap.className = 'pce-size-stepper';
        wrap.title = 'Font size (px)';

        function stepBtn(glyph, title) {
          var b = document.createElement('button');
          b.className = 'pce-icon-btn pce-icon-btn-glyph pce-step-btn';
          b.textContent = glyph;
          b.title = title;
          return b;
        }
        var minus = stepBtn('remove', 'Decrease font size');
        var plus = stepBtn('add', 'Increase font size');

        var input = document.createElement('input');
        input.type = 'number';
        input.className = 'pce-input-control pce-size-input';
        input.min = String(MIN);
        input.max = String(MAX);
        input.value = String(DEFAULT);

        wrap.appendChild(minus);
        wrap.appendChild(input);
        wrap.appendChild(plus);
        this._fontSizeInput = input;

        // The editor is a plain DOM subtree inside the morph: keep these
        // events away from Lively's own handlers.
        [wrap].forEach(function (el) {
          ['mousedown', 'click'].forEach(function (t) {
            el.addEventListener(t, function (e) { e.stopPropagation(); });
          });
        });

        // Applies `size` to the selection; with a bare cursor it sets the
        // stored mark instead, so the next typed text takes that size. The
        // default size clears the mark (no mark = default) rather than
        // storing a redundant one.
        function apply(size) {
          if (!self.editorView) return;
          var view = self.editorView;
          var markType = view.state.schema.marks.fontSize;
          if (!markType) return;
          size = Math.max(MIN, Math.min(MAX, Math.round(size)));
          if (isNaN(size)) return;
          input.value = String(size);
          var sel = view.state.selection, tr = view.state.tr;
          if (sel.from === sel.to) {
            tr = tr.removeStoredMark(markType);
            if (size !== DEFAULT) tr = tr.addStoredMark(markType.create({ size: size + 'px' }));
          } else {
            tr = tr.removeMark(sel.from, sel.to, markType);
            if (size !== DEFAULT) tr = tr.addMark(sel.from, sel.to, markType.create({ size: size + 'px' }));
          }
          view.dispatch(tr);
          view.focus();
        }
        function stepBy(delta) {
          // Step from what the selection really has, not a stale field value.
          self._updateToolbarState();
          apply((parseInt(input.value, 10) || DEFAULT) + delta);
        }
        // mousedown (not click) so the editor keeps its text selection, same
        // as the other toolbar buttons.
        minus.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); stepBy(-1); });
        plus.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); stepBy(1); });

        input.addEventListener('change', function () {
          if (input.value) apply(parseFloat(input.value));
        });
        input.addEventListener('keydown', function (e) {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); if (input.value) apply(parseFloat(input.value)); }
        });
        return wrap;
      },

      // Card-level actions — a floating pill cluster hovering over the
      // bottom-right of the content area (not a docked footer strip; see
      // _buildChrome, which appends this straight to shapeNode after pmDiv
      // so it paints on top, and reserves bottom padding on pmDiv so real
      // content never renders underneath it). Left to right: Location,
      // status, Send, Save (Save rightmost = strongest visual weight,
      // matching the old footer's own right-anchored emphasis).
      _buildFloatingActions: function (shapeNode) {
        var self = this;

        var actionsDiv = document.createElement('div');
        actionsDiv.className = 'pce-floating-actions';
        shapeNode.appendChild(actionsDiv);
        this._floatingActionsDiv = actionsDiv;

        // Preview toggle — leftmost in the capsule; highlighted (pce-active)
        // while the preview overlay is showing (see _togglePreview).
        var previewBtn = document.createElement('button');
        previewBtn.className = 'pce-icon-btn pce-icon-btn-glyph pce-icon-btn-accent';
        previewBtn.textContent = 'visibility';
        previewBtn.title = 'Preview (toggle)';
        previewBtn.addEventListener('mousedown', function (e) {
          e.preventDefault();
          e.stopPropagation();
          self._execToolbarCmd({ cmd: 'preview' });
        });
        actionsDiv.appendChild(previewBtn);
        this._previewBtn = previewBtn;

        // Opt-in coarse location tag (~5.5km cell, never more precise —
        // see PostCardUtils.js's encodeLocation) — click attaches your
        // current location, click again (once attached) to remove it.
        var locationBtn = document.createElement('button');
        locationBtn.className = 'pce-pill-btn pce-pill-neutral';
        locationBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          if (self._locationCode) self._removeLocation();
          else self._promptAttachLocation();
        });
        actionsDiv.appendChild(locationBtn);
        this._locationBtn = locationBtn;
        this._updateLocationBtn();

        var statusSpan = document.createElement('span');
        statusSpan.className = 'pce-status-text';
        actionsDiv.appendChild(statusSpan);
        this._statusEl = statusSpan;

        // Who can see the card: opens the audience dialog (Public, Friends, Orbit,
        // lists, specific people). Sharing this way leaves the card editable; Send,
        // next to it, is the permanent one.
        var audienceBtn = document.createElement('button');
        audienceBtn.className = 'pce-pill-btn pce-pill-neutral';
        audienceBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._openAudienceDialog();
        });
        actionsDiv.appendChild(audienceBtn);
        this._visibilityBtn = audienceBtn;
        this._updateVisibilityBtn();

        // Quiet edit: for a card other people can already read. Off (default), the first
        // save of an editing session tells the people who can read it that it changed;
        // on, it does not. The card is still marked "Edited" and the diff is still there.
        var quietBtn = document.createElement('button');
        quietBtn.className = 'pce-pill-btn pce-pill-neutral';
        quietBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._quietEdit = !self._quietEdit;
          self._updateQuietBtn();
        });
        actionsDiv.appendChild(quietBtn);
        this._quietBtn = quietBtn;
        this._updateQuietBtn();

        var sendBtn = document.createElement('button');
        sendBtn.className = 'pce-pill-btn pce-pill-solid'; // solid: the more consequential, rarer "final" action
        sendBtn.title = 'Send to a handle — delivers the card to their inbox and freezes it, so it can no longer be edited';
        var sendIcon = document.createElement('span');
        sendIcon.className = 'pce-pill-glyph';
        sendIcon.textContent = 'send';
        sendBtn.appendChild(sendIcon);
        sendBtn.appendChild(document.createTextNode('Send'));
        sendBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._promptAndSend();
        });
        actionsDiv.appendChild(sendBtn);

        var saveBtn = document.createElement('button');
        saveBtn.className = 'pce-pill-btn pce-pill-accent-soft'; // soft: frequent, lower-stakes than Send
        saveBtn.title = 'Save now';
        var saveIcon = document.createElement('span');
        saveIcon.className = 'pce-pill-glyph';
        saveIcon.textContent = 'save';
        saveBtn.appendChild(saveIcon);
        saveBtn.appendChild(document.createTextNode('Save'));
        saveBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._saveNow();
        });
        actionsDiv.appendChild(saveBtn);

        // Back-of-card controls: a matching capsule at the bottom-left.
        var backDefs = [
          { icon: 'sticker_add',  title: 'Add a stamp to the back of the card', cmd: 'stamp' },
          { icon: 'flip_to_back', title: 'Back of card (arrange stamps)',       cmd: 'backView' },
        ];
        var backActions = document.createElement('div');
        backActions.className = 'pce-floating-actions pce-floating-actions-left';
        shapeNode.appendChild(backActions);
        this._floatingBackActionsDiv = backActions;
        backDefs.forEach(function (btnDef) {
          var btn = document.createElement('button');
          btn.className = 'pce-icon-btn pce-icon-btn-glyph pce-icon-btn-accent';
          btn.textContent = btnDef.icon;
          btn.title = btnDef.title;
          btn.addEventListener('mousedown', function (e) {
            e.preventDefault();
            e.stopPropagation();
            self._execToolbarCmd(btnDef);
          });
          backActions.appendChild(btn);
        });
      },

      // Reflects the current selection's formatting into the toolbar: active
      // marks get highlighted, color/font/size controls show the current
      // value. Called after every transaction (dispatchTransaction).
      _updateToolbarState: function () {
        if (!this.editorView) return;
        var state = this.editorView.state;

        function activeMarksAtSelection() {
          if (state.selection.empty) return state.storedMarks || state.selection.$from.marks();
          var found = [];
          state.doc.nodesBetween(state.selection.from, state.selection.to, function (node) {
            (node.marks || []).forEach(function (m) {
              if (found.indexOf(m) === -1) found.push(m);
            });
          });
          return found;
        }

        var marks = activeMarksAtSelection();
        function markOfType(name) {
          var type = state.schema.marks[name];
          if (!type) return null;
          for (var i = 0; i < marks.length; i++) {
            if (marks[i].type === type) return marks[i];
          }
          return null;
        }

        (this._toggleButtons || []).forEach(function (entry) {
          var active = !!markOfType(entry.markType);
          entry.btn.classList.toggle('pce-active', active);
        });

        if (this._textColorInput) {
          var tMark = markOfType('textColor');
          this._textColorInput.value = (tMark && tMark.attrs.color) || '#000000';
        }
        if (this._bgColorInput) {
          var bMark = markOfType('backgroundColor');
          this._bgColorInput.value = (bMark && bMark.attrs.color) || '#ffffff';
        }
        if (this._fontFamilySelect) {
          var fMark = markOfType('fontFamily');
          this._fontFamilySelect.value = (fMark && fMark.attrs.family) || '';
        }
        if (this._fontSizeInput) {
          var sMark = markOfType('fontSize');
          // Don't clobber a size the user is mid-typing in the field.
          if (document.activeElement !== this._fontSizeInput) {
            this._fontSizeInput.value = (sMark && sMark.attrs.size)
              ? parseInt(sMark.attrs.size, 10) : this._DEFAULT_FONT_SIZE;
          }
        }

        // Block-level state, read from the cursor's block (selection.$from).
        var block = state.selection.$from.parent;
        if (this._styleSelect) {
          this._styleSelect.value = block.type.name === 'paragraph' ? 'p'
            : block.type.name === 'heading' ? String(block.attrs.level) : '';
        }
        var currentAlign = block.attrs && block.attrs.align;
        (this._alignButtons || []).forEach(function (entry) {
          // Blocks with an align attr but the default read as left-aligned.
          entry.btn.classList.toggle('pce-active', !!currentAlign && entry.align === currentAlign);
        });
        if (this._lineHeightSelect) {
          var lh = block.attrs && block.attrs.lineHeight;
          var lhValue = lh ? String(lh) : '';
          // A value outside the presets (e.g. from an imported card) has no
          // matching option; fall back to the default entry rather than
          // leaving the select blank.
          this._lineHeightSelect.value = lhValue;
          if (this._lineHeightSelect.value !== lhValue) this._lineHeightSelect.value = '';
        }
      },

      // The audience pill: who can open this card, in the same words as the chip on
      // the homestar reel. Clicking it opens the audience dialog.
      _audienceLabel: function () {
        var R = lively.identity.AudienceRules;
        if (this._visibility === 'public') return 'Public';
        if (this._audience) {
          return this._audienceCtx ? R.ownerChipLabel(this._audience, this._audienceCtx, false) : 'Shared';
        }
        // Shared before audiences existed: count who the stored version is sealed
        // to (a card shared that way need not carry a handle list at all).
        var sealed = (this._envelope && this._envelope.record && this._envelope.record.recipients) || [];
        var n = Math.max((this._recipientHandles || []).length, sealed.length);
        return n ? n + (n === 1 ? ' person' : ' people') : 'Only me';
      },

      _updateVisibilityBtn: function () {
        if (!this._visibilityBtn) return;
        var isPublic = this._visibility === 'public';
        var btn = this._visibilityBtn;
        btn.innerHTML = '';
        var icon = document.createElement('span');
        icon.className = 'pce-pill-glyph';
        icon.textContent = isPublic ? 'public' : 'lock';
        btn.appendChild(icon);
        btn.appendChild(document.createTextNode(this._audienceLabel()));
        btn.title = isPublic
          ? 'Public — anyone can read it, and it is not encrypted. Click to change who can see it.'
          : 'Encrypted — only the people listed can open it. Click to change who can see it. You can keep editing a shared card.';
        btn.classList.toggle('pce-pill-neutral', isPublic);
        btn.classList.toggle('pce-pill-accent-soft', !isPublic);
        this._updateQuietBtn();
        this._updateTitleRow();
      },

      // A private or shared card has no title unless the author gives it one, because a
      // title is stored in the clear (an encrypted card's title cannot be searched by the
      // server otherwise, and the old auto-extracted first line leaked the card's text).
      // This row is where the author opts in, and says plainly what that means.
      _buildTitleRow: function (shapeNode) {
        var self = this;
        var row = document.createElement('div');
        row.className = 'pce-title-row';
        row.style.cssText = [
          'position:absolute', 'top:' + this._TOOLBAR_HEIGHT + 'px', 'left:0', 'right:0',
          'height:' + this._TITLE_ROW_HEIGHT + 'px', 'box-sizing:border-box', 'padding:8px 20px',
          'background:#fffaf0', 'border-bottom:1px solid #f0e3c4', 'overflow:hidden',
          'font-family:sans-serif', 'display:none',
        ].join(';');

        var line = document.createElement('div');
        line.style.cssText = 'display:flex;align-items:center;gap:10px;height:32px;';
        var lab = document.createElement('span');
        lab.textContent = 'Title';
        lab.style.cssText = 'font-size:12px;font-weight:600;color:#5a4a1a;flex:0 0 auto;';
        line.appendChild(lab);

        var badge = document.createElement('span');
        badge.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:3px;height:20px;padding:0 8px 0 5px;' +
          'border-radius:10px;background:#fdeec8;border:1px solid #e6c870;color:#7a5200;font-size:11px;font-weight:600;';
        var badgeIcon = document.createElement('span');
        badgeIcon.className = 'material-symbols-rounded';
        badgeIcon.textContent = 'lock_open';
        badgeIcon.style.cssText = 'font-size:14px;line-height:1;';
        badge.appendChild(badgeIcon);
        badge.appendChild(document.createTextNode('Not encrypted'));
        line.appendChild(badge);

        var input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 120;
        input.placeholder = 'Optional. Name this card so you can find it again';
        input.setAttribute('aria-label', 'Card title (not encrypted)');
        input.style.cssText = 'flex:1 1 auto;min-width:0;height:30px;box-sizing:border-box;padding:0 10px;font:13px sans-serif;' +
          'color:#2a2438;border:1px solid #e0d2a8;border-radius:8px;outline:none;background:#fff;user-select:text;';
        input.addEventListener('focus', function () { input.style.borderColor = '#CC0057'; });
        input.addEventListener('blur', function () { input.style.borderColor = '#e0d2a8'; });
        input.addEventListener('input', function () { self._setTitle(input.value); });
        // Keys typed here are not the editor's: same treatment as the font-size field.
        input.addEventListener('keydown', function (e) { e.stopPropagation(); });
        line.appendChild(input);

        var useFirst = document.createElement('button');
        useFirst.textContent = 'Use first line';
        useFirst.title = 'Copy the first line of the card into the title (it will then be stored unencrypted)';
        useFirst.style.cssText = 'flex:0 0 auto;height:26px;padding:0 10px;border:1px solid #e0d2a8;border-radius:13px;' +
          'background:#fff;color:#5a4a1a;font-size:11px;cursor:pointer;';
        useFirst.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          var first = self.editorView && self.editorView.state.doc.firstChild;
          var text = first ? first.textContent.trim().slice(0, 120) : '';
          if (!text) return self._setStatus('The first line is empty');
          input.value = text;
          self._setTitle(text);
        });
        line.appendChild(useFirst);
        row.appendChild(line);

        var note = document.createElement('div');
        note.style.cssText = 'margin-top:4px;font-size:11px;line-height:1.35;color:#7a5c00;';
        row.appendChild(note);

        shapeNode.appendChild(row);
        this._titleRow = row;
        this._titleInput = input;
        this._titleNote = note;
      },

      _setTitle: function (text) {
        this._title = String(text || '');
        this._titleChangePending = true;
        this._markEdited();
        this._updateTitleRow();
      },

      // Is the card shared with anyone but its author, as far as the editor knows?
      _sharedWithOthers: function () {
        if (this._hasReaders()) return true;
        var a = this._audience;
        if (a && ((a.tiers || []).length || (a.people || []).length)) return true;
        return (this._recipientHandles || []).length > 0;
      },

      // Shows the row for a private or shared card that can be edited, keeps the input and
      // the note in step with the model, and moves the content down by the row's height.
      _updateTitleRow: function () {
        var row = this._titleRow;
        if (!row) return;
        // A read-only or frozen card hides the row and has already laid out its own content
        // area (_applyReadOnlyMode); do not move it.
        if (this._canEdit === false) { row.style.display = 'none'; return; }
        var show = this._visibility !== 'public';
        row.style.display = show ? '' : 'none';
        if (this._pmContainer) {
          this._pmContainer.style.top = (this._TOOLBAR_HEIGHT + (show ? this._TITLE_ROW_HEIGHT : 0)) + 'px';
        }
        if (!show) return;
        if (this._titleInput && this._titleInput.value !== (this._title || '')) this._titleInput.value = this._title || '';
        if (this._titleNote) {
          var who = this._sharedWithOthers() ? 'the server and everyone you share this card with' : 'the server';
          this._titleNote.textContent = 'Searchable in your mailbox. Stored in the clear, so ' + who +
            ' can read it. The text of the card stays encrypted.';
          this._titleNote.style.fontWeight = (this._title || '').trim() ? '600' : '400';
        }
      },

      // Can anyone but the owner read the stored version? Same rule as the server's
      // (EditTracking.visibleToOthers); a card that was never saved cannot have readers.
      _hasReaders: function () {
        var env = this._envelope;
        if (!env) return false;
        if (env.visibility === 'public') return true;
        var rs = (env.record && env.record.recipients) || [];
        return rs.some(function (r) { return r && r.did && r.did !== env.did; });
      },

      // The Quiet edit pill only shows for a card that has readers and can still be edited.
      _updateQuietBtn: function () {
        var btn = this._quietBtn;
        if (!btn) return;
        var show = this._hasReaders() && !this._sentLocked;
        btn.style.display = show ? '' : 'none';
        if (!show) return;
        var on = !!this._quietEdit;
        btn.innerHTML = '';
        var icon = document.createElement('span');
        icon.className = 'pce-pill-glyph';
        icon.textContent = on ? 'notifications_off' : 'notifications';
        btn.appendChild(icon);
        btn.appendChild(document.createTextNode(on ? 'Quiet edit' : 'Notifies readers'));
        btn.title = on
          ? 'Quiet edit: people who can read this card will not be told about this edit. They still see it marked as edited and can see what changed. Click to turn off.'
          : 'When you start changing this card, the people who can read it are told it was edited. Turn this on before you start typing to skip that notice (they still see it marked as edited).';
        btn.classList.toggle('pce-pill-accent-soft', on);
        btn.classList.toggle('pce-pill-neutral', !on);
      },

      _updateLocationBtn: function () {
        if (!this._locationBtn) return;
        var has = !!this._locationCode;
        this._locationBtn.innerHTML = '';
        var icon = document.createElement('span');
        icon.className = 'pce-pill-glyph';
        icon.textContent = has ? 'location_on' : 'add_location';
        this._locationBtn.appendChild(icon);
        this._locationBtn.appendChild(document.createTextNode(has ? this._locationCode : 'Add location'));
        this._locationBtn.title = has
          ? 'Location tag: ' + this._locationCode + ' (click to remove)'
          : 'Tag this card with your current coarse location (~5.5km, never more precise)';
        this._locationBtn.classList.toggle('pce-pill-accent-soft', has);
        this._locationBtn.classList.toggle('pce-pill-neutral', !has);
      },

      // Captures the device's current position and immediately floors it to
      // a 6-significant-digit Plus Code (encodeLocation) — raw coordinates
      // are never assigned to a persistent field or held past this callback,
      // so there's nothing more precise than the floor left to leak even if
      // a bug elsewhere mishandled it (server-side PlusCode.js enforces the
      // same floor independently as the actual trust boundary).
      _promptAttachLocation: function () {
        var self = this;
        if (!navigator.geolocation) {
          this._setStatus('Geolocation unavailable');
          return;
        }
        this._ensureGeoRuntime(function () {
          self._setStatus('Locating…');
          navigator.geolocation.getCurrentPosition(function (pos) {
            var code = lively.identity.postCardUtils.encodeLocation(pos.coords.latitude, pos.coords.longitude);
            if (!code) { self._setStatus('Location error'); return; }
            self._locationCode = code;
            self._locationCleared = false;
            self._updateLocationBtn();
            self._markEdited();
            self._setStatus('Location attached');
          }, function () {
            self._setStatus('Location unavailable');
          }, { timeout: 8000, maximumAge: 300000 });
        });
      },

      _removeLocation: function () {
        this._locationCode = null;
        this._locationCleared = true;
        this._updateLocationBtn();
        this._markEdited();
      },

      // A save's stateMeta.location: value | null | undefined — omitted
      // entirely when a location was never attached/removed this session
      // (so an unrelated save doesn't touch an existing stored value),
      // explicit null on removal (so the server can tell "clear it" apart
      // from "no change"), or the floored code when attached.
      _locationStateMeta: function () {
        if (this._locationCode) return { location: this._locationCode };
        if (this._locationCleared) return { location: null };
        return null;
      },

      // Unlike location, reactionsEnabled always has a value
      // (default true) so it's always included, not conditionally
      // omitted — there's no "never touched this session" tri-state to
      // preserve.
      _optionsStateMeta: function () {
        return {
          reactionsEnabled: this._reactionsEnabled !== false,
        };
      },

      // Merges location + options stateMeta into one object for a save —
      // shared by both the public and private/shared save paths.
      //
      // KNOWN BUG (the "save bug"): PostCardSerializer.serializeToEnvelope/
      // serializeEncrypted build `state` fresh each save as
      // Object.assign({}, params.stateMeta, {title}) — they do NOT merge
      // against the previously-stored envelope.state. That's fine for
      // fields this editor itself owns and re-seeds from the loaded
      // envelope every time (location/reactionsEnabled, both handled
      // above) — but ANY state field set by
      // something other than this editor, and that this editor doesn't
      // know to carry forward, gets silently dropped on the next save.
      // Concretely: PostCardView.js's Delete action (§6.3) sets
      // state.deleted:true directly via PUT, bypassing this editor
      // entirely. If that same card is then opened here and an autosave
      // fires — even an incidental one, not a deliberate "undelete"
      // action — this method won't include `deleted` in stateMeta, `state`
      // gets rebuilt without it, and the tombstone is silently undone.
      // PostCardView.js mitigates the obvious path (hides its own Edit
      // button once a card shows as deleted), but a direct
      // PostCardEditor.openCard() call still hits this. Not fixed here —
      // the real fix is either merging against prevEnvelope.state in the
      // serializer, or this editor explicitly seeding/carrying forward
      // `state.deleted` the same way it does for every other field above.
      _composeStateMeta: function (extra) {
        return Object.assign({}, this._locationStateMeta(), this._optionsStateMeta(), this._minorEditMeta(), this._gameStateMeta(), extra || {});
      },

      // The readable marker for a card that carries a game block: { hasGame: true }, so a
      // feed can pick such cards out without the server learning which game. Re-derived from
      // _game on every save (the state is rebuilt each time, see the note above).
      _gameStateMeta: function () {
        return this._game ? { hasGame: true } : {};
      },

      // The document as ProseMirror holds it right now, as a string, or null for a
      // legacy Yjs-backed card (which has no plain document to compare).
      _currentDocJson: function () {
        if (this._isWikiMode || !this.editorView) return null;
        return JSON.stringify(this.editorView.state.doc.toJSON());
      },

      // Remember the document as of the version just loaded, so a save that only
      // changes who can read the card can tell it changed nothing in the text.
      _noteDocSaved: function () {
        this._savedDocJson = this._currentDocJson();
      },

      // A save whose only change is the audience writes a new version (a fresh key
      // for the new people) but the text is the same. The server counts a new version
      // of a card others can read as an edit, so this tells it that one is not worth
      // a notice (`state.editMinor`, read and dropped server-side). Never set when the
      // text differs from the last saved version: that is a real edit.
      _minorEditMeta: function () {
        if (this._quietEdit && this._hasReaders()) return { editMinor: true };
        if (!(this._audienceChangePending || this._titleChangePending) || this._savedDocJson == null) return {};
        return this._savedDocJson === this._currentDocJson() ? { editMinor: true } : {};
      },

      // A small floating chip shown under the cursor when it's inside a link
      // (Google Docs-style) — plain click inside a contenteditable region
      // only places the cursor (browser convention; Ctrl/Cmd-click still
      // opens the link natively), so this is the discoverable way to see the
      // URL, open it, edit it, or remove it without hunting for a selection.
      _buildLinkPreview: function (shapeNode) {
        var self = this;
        var el = document.createElement('div');
        el.className = 'lively-link-preview';
        el.style.cssText = [
          'position:absolute', 'display:none', 'z-index:1000', 'align-items:center', 'gap:8px',
          'background:#fff', 'border:1px solid #ccc', 'border-radius:6px',
          'box-shadow:0 4px 12px rgba(0,0,0,0.18)', 'padding:5px 8px',
          'font-family:sans-serif', 'font-size:12px', 'max-width:320px',
        ].join(';');

        var link = document.createElement('a');
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.style.cssText = 'color:#15c;text-decoration:underline;max-width:200px;overflow:hidden;' +
          'text-overflow:ellipsis;white-space:nowrap;';
        el.appendChild(link);

        var editBtn = document.createElement('button');
        editBtn.textContent = 'Edit';
        editBtn.style.cssText = 'flex:0 0 auto;font-size:11px;padding:2px 8px;cursor:pointer;' +
          'border:1px solid #ccc;border-radius:3px;background:#fff;';
        el.appendChild(editBtn);

        var removeBtn = document.createElement('button');
        removeBtn.textContent = 'Remove';
        removeBtn.style.cssText = 'flex:0 0 auto;font-size:11px;padding:2px 8px;cursor:pointer;' +
          'border:1px solid #c33;border-radius:3px;background:#fff;color:#c33;';
        el.appendChild(removeBtn);

        ['mousedown', 'click'].forEach(function (t) {
          el.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        editBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          if (self._currentLinkRange) self._linkPreviewAction('edit', self._currentLinkRange);
        });
        removeBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          if (self._currentLinkRange) self._linkPreviewAction('remove', self._currentLinkRange);
        });

        shapeNode.appendChild(el);
        this._linkPreviewEl = el;
        this._linkPreviewLinkEl = link;
      },

      _hideLinkPreview: function () {
        this._currentLinkRange = null;
        if (this._linkPreviewEl) this._linkPreviewEl.style.display = 'none';
      },

      // Finds the link mark (if any) touching a collapsed cursor. Only
      // scans the immediate parent block's direct children — sufficient for
      // this schema, where marked text runs are never nested deeper.
      _findLinkRangeAtSelection: function (state, linkType) {
        if (!state.selection.empty) return null;
        var $pos = state.selection.$from;
        var parent = $pos.parent;
        var parentStart = $pos.start();
        var result = null;
        parent.forEach(function (child, childOffset) {
          if (result) return;
          var mark = linkType.isInSet(child.marks || []);
          if (!mark) return;
          var from = parentStart + childOffset;
          var to = from + child.nodeSize;
          if ($pos.pos >= from && $pos.pos <= to) result = { mark: mark, from: from, to: to };
        });
        return result;
      },

      _updateLinkPreview: function () {
        if (!this.editorView || !this._linkPreviewEl) return;
        var view = this.editorView;
        var state = view.state;
        var linkType = state.schema.marks.link;
        if (!linkType) return;

        var range = this._findLinkRangeAtSelection(state, linkType);
        this._currentLinkRange = range;
        if (!range) {
          this._linkPreviewEl.style.display = 'none';
          return;
        }

        this._linkPreviewLinkEl.href = range.mark.attrs.href;
        this._linkPreviewLinkEl.textContent = range.mark.attrs.href;

        var coords = view.coordsAtPos(range.from);
        var shapeRect = this.renderContext().shapeNode.getBoundingClientRect();
        this._linkPreviewEl.style.display = 'flex';
        this._linkPreviewEl.style.left = Math.max(4, coords.left - shapeRect.left) + 'px';
        this._linkPreviewEl.style.top = (coords.bottom - shapeRect.top + 4) + 'px';
      },

      _linkPreviewAction: function (action, range) {
        var view = this.editorView;
        if (!view) return;
        var linkType = view.state.schema.marks.link;
        if (action === 'remove') {
          view.dispatch(view.state.tr.removeMark(range.from, range.to, linkType));
          view.focus();
        } else if (action === 'edit') {
          var href = window.prompt('Edit link URL (blank to remove):', range.mark.attrs.href || 'https://');
          if (href === null) { this._hideLinkPreview(); return; }
          href = href.trim();
          var tr = view.state.tr.removeMark(range.from, range.to, linkType);
          if (href) tr = tr.addMark(range.from, range.to, linkType.create({ href: href }));
          view.dispatch(tr);
          view.focus();
        }
        this._hideLinkPreview();
      },

    },

    // ─── morph-level event overrides ────────────────────────────────────────────────
    // lively.morphic.Morph's default onKeyDown (Events.js) special-cases several
    // keys for every morph regardless of what's actually focused inside it:
    // Backspace unconditionally calls evt.preventDefault() (a guard against
    // legacy browser back-navigation), and Ctrl/Cmd-C / -V are redirected to
    // Lively's own morph-clipboard ("copy this morph") instead of native text
    // clipboard. Both silently break ProseMirror, which relies on the browser's
    // native contenteditable behavior for ordinary backspace/copy/paste. Bypass
    // all of it whenever the ProseMirror view itself actually has focus.

    'morph events', {

      onKeyDown: function ($super, evt) {
        var view = this.editorView;
        // view.hasFocus() is `document.activeElement === view.dom` exactly
        // (prosemirror-view's own source, non-IE branch) — it does NOT count
        // as focused when a custom NodeView has injected its own <input>/
        // <textarea> (e.g. the math NodeView's edit box), which is a
        // descendant of view.dom, never view.dom itself. That gap let this
        // override fall through to Lively's default onBackspacePressed while
        // editing a math formula, reintroducing the exact preventDefault bug
        // this override exists to avoid — hence the extra `contains` check.
        if (view && (view.hasFocus() || (view.dom && view.dom.contains(document.activeElement)))) {
          return false;
        }
        return $super(evt);
      },

    },

    // ─── ProseMirror setup ────────────────────────────────────────────────────────

    'editor', {

      // Inject postcard-runtime.js if Yjs/PM aren't on the page yet, then call back.
      _ensureRuntime: function (callback) {
        if (this._Y() && this._ProseMirror() && this._yProsemirror()) {
          return callback();
        }
        var self = this;
        if (window._postcardRuntimeLoading) {
          var poll = setInterval(function () {
            if (self._Y() && self._ProseMirror()) { clearInterval(poll); callback(); }
          }, 80);
          return;
        }
        window._postcardRuntimeLoading = true;
        this._setStatus('Loading…');
        if (!document.getElementById('katex-css')) {
          var link = document.createElement('link');
          link.id = 'katex-css';
          link.rel = 'stylesheet';
          link.href = '/core/lib/postcard/katex.min.css';
          document.head.appendChild(link);
        }
        if (!document.getElementById('hljs-css')) {
          var hljsLink = document.createElement('link');
          hljsLink.id = 'hljs-css';
          hljsLink.rel = 'stylesheet';
          hljsLink.href = '/core/lib/postcard/hljs-github.css';
          document.head.appendChild(hljsLink);
        }
        var s = document.createElement('script');
        s.src = '/core/lib/postcard/postcard-runtime.js';
        s.onload = function () { window._postcardRuntimeLoading = false; callback(); };
        s.onerror = function () {
          window._postcardRuntimeLoading = false;
          self._showError('Failed to load /core/lib/postcard/postcard-runtime.js');
        };
        document.head.appendChild(s);
      },

      // Lazy-loads core/lib/geo/geo-runtime.js (window.L + window.OpenLocationCode
      // — Leaflet + open-location-code, bundled together since LocalMap.js
      // needs both; PostCardEditor only needs OpenLocationCode, but shares
      // the one bundle rather than adding a second lazy-load path, matching
      // this file's own _ensureRuntime combining several unrelated libs
      // behind one load). Same guard/poll/CSS-link shape as _ensureRuntime.
      _ensureGeoRuntime: function (callback) {
        if (window.L && window.OpenLocationCode) return callback();
        var self = this;
        if (window._geoRuntimeLoading) {
          var poll = setInterval(function () {
            if (window.L && window.OpenLocationCode) { clearInterval(poll); callback(); }
          }, 80);
          return;
        }
        window._geoRuntimeLoading = true;
        if (!document.getElementById('leaflet-css')) {
          var link = document.createElement('link');
          link.id = 'leaflet-css';
          link.rel = 'stylesheet';
          link.href = '/core/lib/geo/leaflet.css';
          document.head.appendChild(link);
        }
        var s = document.createElement('script');
        s.src = '/core/lib/geo/geo-runtime.js';
        s.onload = function () { window._geoRuntimeLoading = false; callback(); };
        s.onerror = function () {
          window._geoRuntimeLoading = false;
          self._showError('Failed to load /core/lib/geo/geo-runtime.js');
        };
        document.head.appendChild(s);
      },

      // Create a fresh document and attach a ProseMirror editor. Every new
      // card is plain (§1.1) — _isWikiMode is always false here (see
      // _setup's comment; a brand-new card can never be the legacy-Yjs-
      // format case that flag exists for) — so this never touches Yjs at
      // all; _attachEditor seeds an empty ProseMirror state directly from
      // local JS, and _connectSync is a no-op for it.
      _createNewDoc: function () {
        var self = this;
        this._audienceLoaded = true;
        this._ensureRuntime(function () {
          self._partState = {};
          self._attachEditor();
          self._connectSync();
          self._applyPrefill();
        });
      },

      // Load the existing envelope from the server, reconstruct its
      // document, then attach.
      _loadExisting: function () {
        var self = this;
        this._ensureRuntime(function () { self._loadExistingNow(); });
      },

      _loadExistingNow: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var url = base + '/@' + encodeURIComponent(this._handle) + '/' + encodeURIComponent(this._objId);
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError('Failed to load postcard: ' + xhr.status);
          var envelope;
          try { envelope = JSON.parse(xhr.responseText); } catch (e) {
            return self._showError('Invalid envelope JSON: ' + e.message);
          }
          self._envelope = envelope;
          self._visibility = envelope.visibility === 'public' ? 'public' : 'private';
          self._recipientHandles = (envelope.state && envelope.state.recipientHandles) || [];
          self._locationCode = (envelope.state && envelope.state.location) || null;
          self._locationCleared = false;
          self._updateLocationBtn();
          self._reactionsEnabled = !(envelope.state && envelope.state.reactionsEnabled === false);
          // Re-seed _constellation from the loaded envelope so a re-save of
          // a plain card already attached to a constellation doesn't lose
          // that attachment (_composeStateMeta/save params only carry
          // forward what this editor knows about). wikiName is not
          // reseeded here at all anymore — a type:'postcard' envelope never
          // legitimately has it (wiki pages are type:'wikipage', handled by
          // WikiEditor.js instead).
          self._constellation = envelope.constellation || null;
          var user = lively.identity.did.currentUser();
          self._isOwner = !!(user && user.did === envelope.did);
          // Every type:'postcard' envelope is owner-only, full stop — the
          // constellation-membership write exception is a wikipage-only
          // concept now (IdentityServer.js's PUT route enforces the same).
          self._canEdit = self._isOwner;
          // A card delivered to an inbox (state.sentAt) is permanent: the server
          // refuses every later write, so open it read-only and say why.
          self._sentLocked = !!(envelope.state && envelope.state.sentAt);
          if (self._sentLocked) self._canEdit = false;
          // A public card's title is normally its auto-extracted first line, which must not
          // become an unencrypted title if the card is later made private; only a title the
          // author set (or any title on an encrypted card, which can only be explicit) is kept.
          var loadedState = envelope.state || {};
          self._title = (envelope.visibility !== 'public' || loadedState.titleExplicit) ? (loadedState.title || '') : '';
          self._updateVisibilityBtn();
          // Read who the card is recorded as shared with before anything can save it.
          if (self._canEdit && self._visibility !== 'public') {
            self._ensureAudienceLoaded(function () {});
          }

          // mode is what THIS stored version's payload.format actually is:
          // 'wiki' here means legacy yjs-update-v1 (a pre-plain/wiki-split
          // postcard, confirmed still present in the dev DB — see
          // PostCardSerializer.js's header), never a real wiki page. No
          // backfill for that; it keeps behaving as the Yjs-backed card it
          // already was until deliberately resaved.
          function _onDeserialized(err, mode, content, payload) {
            if (err) return self._showError('Failed to deserialize: ' + err.message);
            self._isWikiMode = (mode === 'wiki');
            if (mode === 'wiki') {
              self.yDoc = content;
            } else {
              self.yDoc = null;
              self._plainDoc = content;
              self._partState = (payload && payload.partState) || {};
            }
            // §6: attachments travel inside the (now-decrypted, for a
            // private/shared card) payload — the image NodeView/link click
            // handler resolve against this array, not a fresh fetch.
            self._attachments = (payload && payload.attachments) || [];
            // Must be re-seeded here like _attachments: the save params are
            // rebuilt from editor fields each time, so a loaded card's
            // stamps would otherwise vanish on its next autosave.
            self._backStamps = (payload && payload.backStamps) || [];
            self._game = (payload && payload.game) || null;

            self._attachEditor();
            self._noteDocSaved();
            self._applyReadOnlyMode();
            self._connectSync();
          }

          if (envelope.visibility === 'public') {
            // Public payload is plaintext JSON — format is directly
            // readable, no decrypt needed to pick the right deserializer.
            var format = envelope.record && envelope.record.payload && envelope.record.payload.format;
            if (format === 'prosemirror-doc-v1') {
              lively.identity.postCardSerializer.deserializePlainFromEnvelope(envelope, function (err, doc, payload) {
                _onDeserialized(err, 'plain', doc, payload);
              });
            } else {
              lively.identity.postCardSerializer.deserializeFromEnvelope(envelope, function (err, yDoc, payload) {
                _onDeserialized(err, 'wiki', yDoc, payload);
              });
            }
          } else {
            // Private/shared payload is ciphertext — format is unknown
            // until decrypted, so this picks the deserializer AFTER
            // decrypting (see deserializeEncryptedAuto's own doc comment).
            lively.identity.postCardSerializer.deserializeEncryptedAuto(envelope, _onDeserialized);
          }
        };
        xhr.onerror = function () { self._showError('Network error loading postcard'); };
        xhr.send();
      },

      // Append a ProseMirror EditorView to _pmContainer, bound to yDoc via ySyncPlugin.
      _attachEditor: function () {
        var self = this;
        if (!this._pmContainer) return;

        var prosemirror = this._ProseMirror();
        if (!prosemirror) return this._showError('ProseMirror not loaded');

        var schema = this._buildSchema(prosemirror.model);

        var hardBreakCmd = function (state, dispatch) {
          var hb = state.schema.nodes.hard_break;
          if (!hb) return false;
          if (dispatch) dispatch(state.tr.replaceSelectionWith(hb.create()).scrollIntoView());
          return true;
        };

        var plugins;
        var initialDoc = null;

        if (this._isWikiMode) {
          // Wiki mode (§1.2): live multi-writer collaboration over the
          // shared Y.Doc — undo/redo must go through yUndoPlugin (it
          // tracks the CRDT's own undo stack), NOT prosemirror-history,
          // which would fight over document state with no shared doc to
          // reconcile against.
          var yPM = this._yProsemirror();
          if (!yPM) return this._showError('y-prosemirror not loaded');
          var yXmlFragment = this.yDoc.getXmlFragment('prosemirror');
          plugins = [
            yPM.ySyncPlugin(yXmlFragment),
            yPM.yUndoPlugin(), // sole undo/redo — do NOT add prosemirror history() alongside this
            this._buildHighlightPlugin(prosemirror),
            // yUndoPlugin only exposes undo/redo commands, it does not bind any
            // keys itself (confirmed against y-prosemirror's own source/README) —
            // this keymap is required, not optional, or Mod-z/Mod-y do nothing.
            prosemirror.keymap.keymap({ 'Mod-z': yPM.undo, 'Mod-y': yPM.redo, 'Mod-Shift-z': yPM.redo }),
            prosemirror.keymap.keymap({ 'Shift-Enter': hardBreakCmd }),
            prosemirror.keymap.keymap(prosemirror.commands.baseKeymap),
          ];
        } else {
          // Plain mode (§1.1 — every card today): no Yjs doc, so undo/redo
          // uses ProseMirror's own history() plugin instead of yUndoPlugin.
          // _plainDoc (set in _loadExistingNow) seeds the initial state for
          // an existing card; a brand-new card starts from an empty doc
          // (EditorState.create's default when no `doc` option is given).
          if (!prosemirror.history || !prosemirror.history.history) {
            return this._showError('prosemirror-history not loaded');
          }
          if (this._plainDoc) {
            try {
              initialDoc = schema.nodeFromJSON(this._plainDoc);
            } catch (e) {
              return this._showError('Failed to parse saved document: ' + e.message);
            }
            // Consumed — editorView.state.doc is the live source of truth
            // from here on, no need to keep a redundant stale copy around.
            this._plainDoc = null;
          }
          plugins = [
            prosemirror.history.history(),
            this._buildHighlightPlugin(prosemirror),
            this._buildLinkPreviewPlugin(prosemirror),
            prosemirror.keymap.keymap({
              'Mod-z': prosemirror.history.undo,
              'Mod-y': prosemirror.history.redo,
              'Mod-Shift-z': prosemirror.history.redo,
            }),
            prosemirror.keymap.keymap({ 'Shift-Enter': hardBreakCmd }),
            prosemirror.keymap.keymap(prosemirror.commands.baseKeymap),
          ];
        }

        // List-aware keymaps: Enter splits list items, Tab sinks/lifts them.
        // Must be inserted before baseKeymap so Enter is handled by splitListItem first.
        var sl = prosemirror.schemaList;
        if (sl && schema.nodes.list_item) {
          // splitListItem copies the split item's attrs onto the new item, so
          // pressing Enter on a checked checklist item would start the next
          // one already checked — reset it on the resulting transaction.
          var splitItem = sl.splitListItem(schema.nodes.list_item);
          var splitListItemUnchecked = function (state, dispatch, view) {
            return splitItem(state, dispatch ? function (tr) {
              var $s = tr.selection.$from;
              for (var d = $s.depth; d > 0; d--) {
                var item = $s.node(d);
                if (item.type.name === 'list_item') {
                  if (item.attrs.checked === true) {
                    tr.setNodeMarkup($s.before(d), null, Object.assign({}, item.attrs, { checked: false }));
                  }
                  break;
                }
              }
              dispatch(tr);
            } : undefined, view);
          };
          plugins.unshift(prosemirror.keymap.keymap({
            'Enter':     splitListItemUnchecked,
            'Tab':       sl.sinkListItem(schema.nodes.list_item),
            'Shift-Tab': sl.liftListItem(schema.nodes.list_item),
          }));
        }

        var stateOpts = { schema: schema, plugins: plugins };
        if (initialDoc) stateOpts.doc = initialDoc;

        this.editorView = new prosemirror.view.EditorView(this._pmContainer, {
          state: prosemirror.state.EditorState.create(stateOpts),
          nodeViews: {
            math_inline:  function (node, view, getPos) { return self._mathNodeView(node, view, getPos); },
            math_display: function (node, view, getPos) { return self._mathNodeView(node, view, getPos); },
            embeddedPart: function (node, view, getPos) { return self._embeddedPartNodeView(node, view, getPos); },
            link_preview_card: function (node, view, getPos) { return self._linkPreviewCardNodeView(node, view, getPos); },
            image:        function (node, view, getPos) { return self._attachmentImageNodeView(node, view, getPos); },
            video:        function (node, view, getPos) { return self._attachmentVideoNodeView(node, view, getPos); },
            audio:        function (node, view, getPos) { return self._attachmentAudioNodeView(node, view, getPos); },
          },
          handleDOMEvents: {
            blur: function () { self._hideLinkPreview(); return false; },
            // Non-image attachment links (§6): a private/shared one has no
            // real href (see the link mark's toDOM above) — intercept the
            // click and resolve+decrypt on demand instead of navigating.
            click: function (view, event) {
              // Checklist checkbox: it's the li's ::before glyph (see
              // PostCardUtils's checklist CSS), so a click on it targets the
              // li itself, within its left 28px gutter.
              var li = event.target;
              if (li && li.tagName === 'LI' && li.parentNode && li.parentNode.getAttribute &&
                  li.parentNode.getAttribute('data-type') === 'checklist' &&
                  event.clientX - li.getBoundingClientRect().left < 28) {
                var itemPos = view.posAtDOM(li, 0) - 1;
                var itemNode = view.state.doc.nodeAt(itemPos);
                if (itemNode && itemNode.type.name === 'list_item') {
                  view.dispatch(view.state.tr.setNodeMarkup(itemPos, null,
                    Object.assign({}, itemNode.attrs, { checked: itemNode.attrs.checked !== true })));
                  event.preventDefault();
                  return true;
                }
              }
              var a = event.target && event.target.closest && event.target.closest('a[data-attachment-obj-id]');
              if (!a) return false;
              event.preventDefault();
              self._openAttachment(a.getAttribute('data-attachment-obj-id'));
              return true;
            },
          },
          dispatchTransaction: function (tr) {
            // ProseMirror calls this as dispatchTransaction.call(editorView, tr),
            // so 'this' is the EditorView. self.editorView is null during construction
            // because ySyncPlugin fires a dispatch synchronously in new EditorView().
            var view = self.editorView || this;
            var newState = view.state.apply(tr);
            view.updateState(newState);
            if (tr.docChanged) {
              console.log('[PostCardEditor] docChanged steps:', tr.steps.length,
                'content:', JSON.stringify(newState.doc.toJSON()).slice(0, 120));
              // The prefilled text of a card opened from another feature is not an edit by
              // the author: it must not start an autosave (and so create and share the card)
              // before they have looked at it. See _applyPrefill.
              if (!tr.getMeta('prefill')) self._markEdited();
            }
            self._updateToolbarState();
            self._updateLinkPreview();
          },
        });
        this._updateToolbarState();
        this._updateLinkPreview();
      },

      // Syntax-highlights code_block content via inline Decorations rather
      // than a NodeView — code_block's content is real editable text
      // (unlike the atomic math/embed nodes), so we can't just replace its
      // DOM; decorations let highlight.js's classes render on top of the
      // exact same ProseMirror-managed text without touching editability.
      // Re-highlights on every doc change (recomputing per code_block on
      // each keystroke is cheap at postcard-sized documents).
      _buildHighlightPlugin: function (prosemirror) {
        var Plugin = prosemirror.state.Plugin;
        var PluginKey = prosemirror.state.PluginKey;
        var Decoration = prosemirror.view.Decoration;
        var DecorationSet = prosemirror.view.DecorationSet;
        // props.decorations is called as a plain function (view.someProp does
        // `f(view.state)`, not `f.call(plugin, ...)`), so `this` inside it is
        // NOT the plugin instance — read state via a closed-over PluginKey
        // instead of `this.getState(...)`.
        var key = new PluginKey('postcardHighlight');

        function highlightCodeBlock(pos, text) {
          var hljs = (typeof window !== 'undefined' && window.hljs) || null;
          if (!hljs || !text) return [];
          var result;
          try { result = hljs.highlightAuto(text); } catch (e) { return []; }
          // hljs's output is the same text wrapped in nested <span class="hljs-...">
          // — walk it to recover flat (start, end, classes) ranges over the
          // original plain-text offsets (pos+1 is the first character inside
          // the node, per ProseMirror's position convention).
          var container = document.createElement('div');
          container.innerHTML = result.value;
          var decos = [];
          var offset = 0;
          function walk(domNode, classes) {
            if (domNode.nodeType === 3) {
              var len = domNode.nodeValue.length;
              if (classes.length) {
                decos.push(Decoration.inline(pos + 1 + offset, pos + 1 + offset + len,
                  { class: classes.join(' ') }));
              }
              offset += len;
              return;
            }
            if (domNode.nodeType === 1) {
              var childClasses = domNode.className ? classes.concat(domNode.className.split(' ')) : classes;
              for (var i = 0; i < domNode.childNodes.length; i++) walk(domNode.childNodes[i], childClasses);
            }
          }
          for (var i = 0; i < container.childNodes.length; i++) walk(container.childNodes[i], []);
          return decos;
        }

        return new Plugin({
          key: key,
          state: {
            init: function (_config, state) { return computeDecorations(state); },
            apply: function (tr, old, _oldState, newState) {
              return tr.docChanged ? computeDecorations(newState) : old;
            },
          },
          props: {
            decorations: function (state) { return key.getState(state); },
          },
        });

        function computeDecorations(state) {
          var decos = [];
          state.doc.descendants(function (node, pos) {
            if (node.type.name !== 'code_block') return;
            decos = decos.concat(highlightCodeBlock(pos, node.textContent));
          });
          return DecorationSet.create(state.doc, decos);
        }
      },

      // Live "link preview" card while composing — the counterpart to
      // PostCardUtils.js's hydrateLinkPreviews for the read-only render,
      // but that function works by setting .innerHTML on a plain DOM
      // container, which would fight ProseMirror for ownership of this
      // editor's DOM (ProseMirror re-renders its own subtree from the doc
      // model on every change; a sibling node spliced in by hand doesn't
      // survive that). Decorations are the correct mechanism for "extra,
      // non-document chrome inside the editor" — same idiom as
      // _buildHighlightPlugin's syntax-highlight spans, here used for a
      // block WIDGET decoration instead of inline ones.
      //
      // "Bare link paragraph" detection mirrors PostCardUtils.js's
      // _bareLinkUrlOf exactly, just over the ProseMirror doc model instead
      // of rendered HTML: a paragraph whose only child is a single text
      // node that's either fully covered by a link mark, or itself looks
      // like a bare URL (this editor has no autolink-on-paste input rule —
      // see _promptLink's own header comment — so a pasted bare URL is
      // plain, unmarked text; this intentionally does NOT add a real link
      // mark for it, just a visual decoration + the preview widget, to
      // avoid mutating the document as a side effect of rendering).
      //
      // Fetching is async (postCardUtils.fetchLinkPreview, shared cache
      // with the read-only render and this editor's own earlier look at
      // the same URL) but computing decorations must stay a pure,
      // synchronous read of state — ProseMirror calls it on every
      // keystroke. So: peekLinkPreview reads the cache without ever
      // triggering an XHR itself; if a URL has no cache entry yet, this
      // kicks off fetchLinkPreview as a side effect of computeDecorations
      // (acceptable — it's idempotent and cheap, _fetchLinkPreview itself
      // dedupes concurrent/duplicate calls for the same url) and dispatches
      // a no-op-to-the-doc transaction tagged with this plugin's key once
      // the fetch resolves, purely to force decorations to recompute with
      // the now-cached result.
      //
      // Decoration -> persisted node: the decoration above is deliberately
      // ephemeral (it survives neither deleting the url text nor save/
      // reload). Once the fetch has resolved AND the selection has moved
      // out of that paragraph, this plugin's own `view()` hook (below)
      // converts it into a REAL link_preview_card node via a dispatched
      // transaction, so it survives both. Using `view().update(view)` to
      // check "is the current selection outside paragraph P" against the
      // CURRENT doc on every transition (rather than diffing against
      // prevState/trying to map a captured position forward) sidesteps the
      // staleness risk a setTimeout/rAF-based deferral would have against
      // remote edits in WikiEditor.js's Yjs mode (not applicable to this
      // plain-mode copy, but the two are hand-mirrored) — there's nothing
      // to go stale since every check re-reads view.state.doc fresh.
      _buildLinkPreviewPlugin: function (prosemirror) {
        var self = this;
        var Plugin = prosemirror.state.Plugin;
        var PluginKey = prosemirror.state.PluginKey;
        var Decoration = prosemirror.view.Decoration;
        var DecorationSet = prosemirror.view.DecorationSet;
        var closeHistory = prosemirror.history.closeHistory;
        var key = new PluginKey('postcardLinkPreview');
        var BARE_URL_RE = /^(https?:\/\/[^\s<>"']+)$/i;
        var LINK_PREVIEW_FETCH_DEBOUNCE_MS = 600;
        // pos (paragraph start) -> pending setTimeout id. Debounces the
        // real network fetch computeDecorations would otherwise kick off on
        // EVERY keystroke -- confirmed live (chrome-devtools, typing a
        // 44-char YouTube URL one character at a time): without this, each
        // keystroke's in-progress substring is itself a distinct cache key
        // (e.g. ".../watch?v=d", ".../watch?v=dQ", ...), so each one fires
        // its own real outbound fetchLinkPreview call -- 35 real requests
        // for one pasted/typed link, 14 of them 502ing, easily blowing
        // through LinkPreviewServer.js's 20-req/min-per-IP rate limit after
        // a single link. Worse, once the in-progress text happens to look
        // like a YouTube watch URL with ANY non-empty `v=` value --
        // including a garbage one-or-two-character mid-typed fragment, since
        // detectEmbed's old regex accepted any non-empty id -- that keystroke
        // resolves to a real (bogus) embedUrl and, if the user pauses there
        // even briefly, renders a genuine heavyweight YouTube iframe (ads/
        // tracking calls and all) for a video that doesn't exist. Normal
        // human typing (with natural pauses) hits this; fast scripted typing
        // doesn't, which is why it didn't show up until tested with
        // realistic pacing. Keyed by paragraph start position (stable while
        // typing within one paragraph) rather than by url (which changes
        // every keystroke and so can't dedupe against itself).
        var _fetchDebounceTimers = {};

        function scheduleFetch(pos, url) {
          if (_fetchDebounceTimers[pos]) clearTimeout(_fetchDebounceTimers[pos]);
          _fetchDebounceTimers[pos] = setTimeout(function () {
            delete _fetchDebounceTimers[pos];
            var view = self.editorView;
            if (!view) return;
            var node = view.state.doc.nodeAt(pos);
            // Bail if the paragraph moved on since this was scheduled (more
            // typing, or the paragraph is simply gone) -- only ever fetch
            // for text that's still actually current.
            if (!node || bareUrlOf(node) !== url) return;
            lively.identity.postCardUtils.fetchLinkPreview(url, requestRefresh);
          }, LINK_PREVIEW_FETCH_DEBOUNCE_MS);
        }

        function bareUrlOf(node) {
          if (node.type.name !== 'paragraph' || node.childCount !== 1) return null;
          var child = node.firstChild;
          if (!child.isText) return null;
          var linkType = node.type.schema.marks.link;
          var mark = linkType && linkType.isInSet(child.marks || []);
          if (mark) {
            var href = mark.attrs.href || '';
            return /^https?:\/\//i.test(href) ? href : null;
          }
          var m = BARE_URL_RE.exec((child.text || '').trim());
          return m ? m[1] : null;
        }

        // True when a link_preview_card for `url` already sits immediately
        // after the paragraph ending at `endPos` — covers both "this
        // plugin already converted it" and legacy content that happened to
        // already have one. Shared by computeDecorations (skip the
        // decoration) and maybeCommit (skip re-inserting).
        function hasSiblingCard(doc, endPos, url) {
          var next = doc.nodeAt(endPos);
          return !!(next && next.type.name === 'link_preview_card' && next.attrs.url === url);
        }

        function requestRefresh() {
          // self.editorView is null until the constructor's `new
          // EditorView(...)` call returns (see dispatchTransaction's own
          // comment on this same race) — a cache hit resolving
          // synchronously-ish during that window just gets skipped; the
          // next real doc-changing transaction recomputes from the
          // now-warm cache anyway, so nothing is lost, just not shown one
          // keystroke early.
          var view = self.editorView;
          if (!view) return;
          view.dispatch(view.state.tr.setMeta(key, true));
        }

        function computeDecorations(state) {
          var U = lively.identity.postCardUtils;
          var decos = [];
          state.doc.descendants(function (node, pos) {
            // BUG FIX (caught before ever landing): returning false here
            // for every non-paragraph node — not just paragraphs — would
            // stop ProseMirror's walk from descending into list_item/
            // blockquote entirely, silently hiding previews for any link
            // nested inside one. Only a paragraph is a dead end for this
            // search; every other container must keep descending.
            if (node.type.name !== 'paragraph') return true;
            var url = bareUrlOf(node);
            if (!url) return false;
            var widgetPos = pos + node.nodeSize;
            var cached = U.peekLinkPreview(url);
            if (cached === undefined) {
              // Cache cold -- can't yet know the server-resolved url (see
              // the BUG FIX note below), but a sibling card at this
              // position can only exist from an earlier resolution of this
              // same paragraph, so the bare-url check is a safe (if
              // occasionally over-cautious — see that note) early bail.
              if (hasSiblingCard(state.doc, widgetPos, url)) return false;
              scheduleFetch(pos, url);
              return false;
            }
            if (_fetchDebounceTimers[pos]) { clearTimeout(_fetchDebounceTimers[pos]); delete _fetchDebounceTimers[pos]; }
            if (cached === null || cached.err || !cached.body || cached.body.error) return false;
            // BUG FIX (caught live: a pasted Reddit share link duplicated
            // its own card endlessly): match against the server-RESOLVED
            // url (cached.body.url), not the originally pasted/typed text.
            // LinkPreviewServer.js always returns result.finalUrl, which
            // for a redirecting link (a Reddit /r/<sub>/s/<token> share
            // link, any shortlink, etc.) differs from what's still sitting
            // in the paragraph. Comparing against the bare text here used
            // to never match the already-inserted card's own attrs.url
            // (set from that same resolved value by maybeCommit below), so
            // every transition saw "no sibling card yet" and inserted
            // ANOTHER one — same mismatch, same fix, in maybeCommit itself.
            if (hasSiblingCard(state.doc, widgetPos, cached.body.url)) return false;
            decos.push(Decoration.widget(widgetPos, function () {
              return U.buildLinkPreviewCard(cached.body);
            }, { key: 'link-preview-' + url, side: 1, stopEvent: function () { return true; } }));
            return false;
          });
          return DecorationSet.create(state.doc, decos);
        }

        // Checks every bare-url paragraph in the CURRENT doc and converts
        // the first one eligible (resolved cache, selection outside it, no
        // sibling card yet) into a real node. Called after every
        // transition (local or remote) via the `view()` hook below.
        function maybeCommit(view) {
          var state = view.state;
          var U = lively.identity.postCardUtils;
          var sel = state.selection;
          var found = null;
          state.doc.descendants(function (node, pos) {
            if (found) return false;
            if (node.type.name !== 'paragraph') return true;
            var url = bareUrlOf(node);
            if (!url) return false;
            var start = pos, end = pos + node.nodeSize;
            if (sel.from <= end && sel.to >= start) return false; // selection still touches this paragraph
            var cached = U.peekLinkPreview(url);
            if (!cached || cached.err || !cached.body || cached.body.error) return false;
            // BUG FIX: see computeDecorations' identical fix above — match
            // against the resolved cached.body.url, not the bare pasted
            // text, or a redirecting link never recognizes its own
            // already-inserted card and re-inserts another one forever.
            if (hasSiblingCard(state.doc, end, cached.body.url)) return false;
            found = { endPos: end, body: cached.body };
            return false;
          });
          if (!found) return;
          var nodeType = state.schema.nodes.link_preview_card;
          var tr = state.tr.insert(found.endPos, nodeType.create({
            url: found.body.url || '', title: found.body.title || null,
            description: found.body.description || null, image: found.body.image || null,
            siteName: found.body.siteName || null, provider: found.body.provider || null,
            embedUrl: found.body.embedUrl || null, bluesky: found.body.bluesky || null,
          }));
          // Without this, the insert lands outside prosemirror-history's
          // ~500ms grouping window (the unfurl fetch alone can take
          // seconds) and becomes its own silent undo step — pressing Undo
          // once right after the card appears would do nothing visible.
          if (closeHistory) closeHistory(tr);
          view.dispatch(tr);
        }

        return new Plugin({
          key: key,
          state: {
            init: function (_config, state) { return computeDecorations(state); },
            apply: function (tr, old, _oldState, newState) {
              return (tr.docChanged || tr.getMeta(key)) ? computeDecorations(newState) : old;
            },
          },
          props: {
            decorations: function (state) { return key.getState(state); },
          },
          view: function (editorView) {
            return { update: function (view) { maybeCommit(view); } };
          },
        });
      },

      // NodeView for math_inline/math_display (§10.1): renders via KaTeX when
      // not selected, swaps to a plain input/textarea for editing the LaTeX
      // source when selected — the standard prosemirror-math interaction.
      // Shared by both math node types; node.type.name picks displayMode.
      _mathNodeView: function (node, view, getPos) {
        var isDisplay = node.type.name === 'math_display';
        var dom = document.createElement(isDisplay ? 'div' : 'span');
        dom.className = 'lively-math-node ' + (isDisplay ? 'math-display' : 'math-inline');
        var editing = false;
        var input = null;

        function render() {
          dom.innerHTML = '';
          dom.classList.remove('lively-math-error', 'lively-math-empty');
          if (!node.attrs.value) {
            dom.classList.add('lively-math-empty');
            dom.textContent = isDisplay ? '∑ (click to edit)' : '∑';
            return;
          }
          var katex = (typeof window !== 'undefined' && window.katex) || null;
          if (!katex) { dom.textContent = node.attrs.value; return; }
          try {
            katex.render(node.attrs.value, dom, { throwOnError: true, displayMode: isDisplay });
          } catch (e) {
            dom.textContent = node.attrs.value;
            dom.classList.add('lively-math-error');
            dom.title = e.message;
          }
        }

        function commit() {
          if (!editing) return;
          editing = false;
          var value = input ? input.value : node.attrs.value;
          input = null;
          if (value === node.attrs.value) return render();
          var pos = typeof getPos === 'function' ? getPos() : null;
          if (pos === null || pos === undefined) return render();
          view.dispatch(view.state.tr.setNodeMarkup(pos, null,
            Object.assign({}, node.attrs, { value: value })));
        }

        function startEditing() {
          if (editing) return;
          editing = true;
          dom.innerHTML = '';
          input = document.createElement(isDisplay ? 'textarea' : 'input');
          input.className = 'lively-math-input';
          input.value = node.attrs.value || '';
          input.addEventListener('mousedown', function (e) { e.stopPropagation(); });
          input.addEventListener('keydown', function (e) {
            e.stopPropagation();
            if (e.key === 'Escape' || (e.key === 'Enter' && !isDisplay)) {
              e.preventDefault();
              commit();
              view.focus();
            }
          });
          input.addEventListener('blur', function () { commit(); });
          dom.appendChild(input);
          input.focus();
        }

        // Click-to-edit only — NOT tied to selectNode(). A NodeSelection can
        // land on this node for reasons that have nothing to do with wanting
        // to edit it (Backspace's "select before delete" step, arrow-key
        // navigation stepping past it) — auto-entering edit mode from
        // selectNode() hijacked that native focus, which broke both the
        // normal "select, then Backspace again to delete" flow (the second
        // Backspace just edited the LaTeX text instead of removing the node)
        // and made arrow-keying past a formula look like it randomly
        // switched to a raw-text rendering glitch.
        dom.addEventListener('mousedown', function (e) {
          if (editing) return; // let the input's own mousedown handler run
          e.preventDefault();
          startEditing();
        });

        // A freshly-inserted node (the toolbar's ∑ button creates one with
        // value:'') needs to be immediately typeable — otherwise the very
        // next keystroke lands on a NodeSelection over an atomic node, which
        // ProseMirror treats as "replace the selection," deleting the node
        // and leaving plain typed text behind (looks like the formula
        // "disappeared"). Existing non-empty formulas never hit this path
        // (their NodeView is reused via update(), not reconstructed), so
        // this doesn't reintroduce the selectNode()-auto-edit bug above.
        if (!node.attrs.value) startEditing();
        else render();

        return {
          dom: dom,
          update: function (newNode) {
            if (newNode.type !== node.type) return false;
            node = newNode;
            if (!editing) render();
            return true;
          },
          selectNode: function () { dom.classList.add('lively-math-selected'); },
          deselectNode: function () { dom.classList.remove('lively-math-selected'); commit(); },
          stopEvent: function () { return editing; },
          ignoreMutation: function () { return true; },
        };
      },

      // Makes the view read-only for non-owners: a shared/public card opened
      // by anyone but its author (PUT is owner-only server-side regardless,
      // see IdentityServer.js). Strips the toolbar down to a plain label
      // rather than leaving Save/Send/visibility controls that would just
      // 403 or make no sense for someone who isn't the owner.
      _applyReadOnlyMode: function () {
        if (this._canEdit) return;
        if (this.editorView) {
          this.editorView.setProps({ editable: function () { return false; } });
        }
        if (this._toolbarDiv) {
          this._toolbarDiv.innerHTML = '';
          this._toolbarDiv.style.cssText = [
            'position:absolute', 'top:0', 'left:0', 'right:0', 'height:28px',
            'background:#f0f0f5', 'border-bottom:1px solid #ccc',
            'box-sizing:border-box', 'display:flex', 'align-items:center',
            'padding:0 10px',
          ].join(';');
          var label = document.createElement('span');
          label.style.cssText = 'font-size:11px;color:#888;font-family:sans-serif;';
          label.textContent = this._sentLocked
            ? 'Sent to an inbox, so this card is frozen and can no longer be edited.'
            : 'Read-only — shared by @' + (this._handle || '');
          this._toolbarDiv.appendChild(label);
        }
        // The floating action cluster is a sibling of toolbarDiv/pmDiv under
        // shapeNode now (not nested inside toolbarDiv), so it isn't wiped by
        // the innerHTML='' above and must be hidden explicitly.
        if (this._floatingActionsDiv) this._floatingActionsDiv.style.display = 'none';
        if (this._floatingBackActionsDiv) this._floatingBackActionsDiv.style.display = 'none';
        if (this._titleRow) this._titleRow.style.display = 'none';
        if (this._pmContainer) {
          this._pmContainer.style.top = '28px';
          this._pmContainer.style.bottom = '0';
        }
      },

      // Connects to LiveDocSyncServer via WebsocketProvider for live
      // collaboration. Wiki mode only (§1.2) — a plain card (§1.1, every
      // card today) never has a Yjs doc to sync in the first place, and
      // never opening this connection for it is also what closes the
      // plaintext-in-relay gap Encryption.md §8 flagged, as a side effect
      // rather than a targeted fix (PostcardDesignSpec-v2.md §1.1/§11).
      // Gracefully degrades if y-websocket is unavailable.
      _connectSync: function () {
        if (!this._isWikiMode) return;
        if (!this._objId) return; // no sync until first save establishes objId
        if (!this.yDoc) return; // defensive — WebsocketProvider requires one

        var WebsocketProvider = this._WebsocketProvider();
        if (!WebsocketProvider) {
          console.warn('[PostCardEditor] WebsocketProvider not loaded — live sync disabled');
          return;
        }

        // Same origin/port as the page itself -- LiveDocSyncServer.js rides
        // the shared WS listener under /livedoc-sync/, no separate port to
        // configure or inject any more. wss: required whenever the page
        // itself is https: — browsers block insecure ws: connections from
        // a secure page.
        var wsScheme = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss:' : 'ws:';
        var wsUrl = wsScheme + '//' + location.host + '/livedoc-sync';
        try {
          this.wsProvider = new WebsocketProvider(wsUrl, this._objId, this.yDoc, { connect: true });
          this.wsProvider.on('status', function (event) {
            console.log('[PostCardEditor] sync status:', event.status);
          });
        } catch (e) {
          console.warn('[PostCardEditor] Failed to start WebSocket sync (non-fatal):', e.message);
        }
      },

    },

    // ─── back of card: stamps ─────────────────────────────────────────────────────
    //
    // The editor itself is one ProseMirror document, so the back face is a
    // separate plain-DOM view swapped in over pmDiv (see _showBackView).
    // Stamps are uploaded through the same FileCrypto path as inline
    // attachments (_uploadFileEntry) and stored as payload.backStamps:
    // [{ objId, x, y, w, ar }] — x/y/w are fractions of the face (so the
    // layout scales with whatever size PostCardView renders the back at) and
    // ar is natural width/height (so height always follows aspect ratio).
    // Rendered as plain <img> (never via canvas) so animated GIF/WebP stay
    // animated.

    'back view', {

      // Reference face size: PostCardView's default 420x300 extent. A stamp
      // is capped at _STAMP_MAX_W x _STAMP_MAX_H *on this reference face*
      // and shrunk proportionally if its natural size exceeds that.
      _BACK_W: 420,
      _BACK_H: 300,
      _STAMP_MAX_W: 160,
      _STAMP_MAX_H: 110,

      _buildBackView: function (shapeNode) {
        var self = this;

        function pill(glyph, label, cls, onClick) {
          var b = document.createElement('button');
          b.className = 'pce-pill-btn ' + cls;
          var g = document.createElement('span');
          g.className = 'pce-pill-glyph';
          g.textContent = glyph;
          b.appendChild(g);
          b.appendChild(document.createTextNode(label));
          b.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            onClick();
          });
          return b;
        }

        // Replaces the formatting toolbar while the back is showing — none of
        // its commands apply to the back face.
        var bar = document.createElement('div');
        bar.style.cssText = [
          'position:absolute', 'top:0', 'left:0', 'right:0', 'height:' + this._TOOLBAR_HEIGHT + 'px',
          'background:#fff', 'border-bottom:1px solid #eee', 'box-sizing:border-box',
          'display:none', 'align-items:center', 'gap:8px', 'padding:0 12px', 'z-index:6',
          'font-family:sans-serif',
        ].join(';');
        bar.appendChild(pill('arrow_back', 'Front', 'pce-pill-neutral', function () { self._showBackView(false); }));
        bar.appendChild(pill('sticker_add', 'Add stamp', 'pce-pill-accent-soft', function () { self._promptStamp(); }));
        var hint = document.createElement('span');
        hint.style.cssText = 'font-size:11px;color:#999;margin-left:6px;line-height:1.4;';
        hint.textContent = 'Back of card. Drag stamps to place them, click one to select it. ' +
          'Large stamps are shrunk to fit ' + this._STAMP_MAX_W + '×' + this._STAMP_MAX_H + '.';
        bar.appendChild(hint);
        shapeNode.appendChild(bar);
        this._backBar = bar;

        var backDiv = document.createElement('div');
        backDiv.style.cssText = [
          'position:absolute', 'top:' + this._TOOLBAR_HEIGHT + 'px', 'left:0', 'right:0', 'bottom:0',
          'overflow:auto', 'background:#f4f4f7', 'display:none', 'box-sizing:border-box',
          'padding:24px 0 ' + this._FLOATING_ACTIONS_CLEARANCE + 'px 0',
        ].join(';');
        shapeNode.appendChild(backDiv);
        this._backDiv = backDiv;

        var face = document.createElement('div');
        face.style.cssText = [
          'position:relative', 'width:' + this._BACK_W + 'px', 'height:' + this._BACK_H + 'px',
          'margin:0 auto', 'background:#fff', 'border-radius:10px', 'overflow:hidden',
          'box-shadow:0 2px 10px rgba(0,0,0,0.14)', 'font-family:sans-serif',
        ].join(';');
        backDiv.appendChild(face);
        this._backFace = face;

        // Faded stand-ins for what PostCardView draws on the real back, so
        // the author can see what a stamp will sit over.
        var ghost = document.createElement('div');
        ghost.style.cssText = 'position:absolute;inset:0;pointer-events:none;color:#c8c8d0;';
        var ghostStamp = document.createElement('div');
        ghostStamp.textContent = '✉';
        ghostStamp.style.cssText = [
          'position:absolute', 'top:10px', 'right:10px', 'width:44px', 'height:52px',
          'border:2px dashed currentColor', 'border-radius:3px', 'display:flex',
          'align-items:center', 'justify-content:center', 'font-size:18px',
        ].join(';');
        ghost.appendChild(ghostStamp);
        var ghostMeta = document.createElement('div');
        ghostMeta.style.cssText = 'position:absolute;top:16px;left:14px;font-size:11px;line-height:1.9;';
        ghostMeta.innerHTML = 'From: …<br>CID: …<br>Sent: …<br>Visibility: …';
        ghost.appendChild(ghostMeta);
        face.appendChild(ghost);

        var layer = document.createElement('div');
        layer.style.cssText = 'position:absolute;inset:0;';
        layer.addEventListener('pointerdown', function (e) {
          if (e.target === layer) self._selectStamp(-1);
        });
        face.appendChild(layer);
        this._stampLayer = layer;
      },

      _showBackView: function (on) {
        if (on && this._isWikiMode) {
          this._setStatus('Stamps need a plain card');
          return;
        }
        this._backViewActive = !!on;
        this._backBar.style.display = on ? 'flex' : 'none';
        this._backDiv.style.display = on ? 'block' : 'none';
        this._pmContainer.style.display = on ? 'none' : '';
        if (on) this._refreshBackStamps();
        else if (this.editorView) this.editorView.focus();
      },

      _promptStamp: function () {
        var self = this;
        if (!this._canEdit) return;
        if (this._isWikiMode) { this._setStatus('Stamps need a plain card'); return; }
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', function () {
          var file = input.files && input.files[0];
          if (input.parentNode) input.parentNode.removeChild(input);
          if (file) self._addStampFromFile(file);
        });
        input.click();
      },

      // Reads the natural size first (so an unreadable file is rejected
      // before anything is uploaded), then uploads and appends the stamp.
      _addStampFromFile: function (file) {
        var self = this;
        // Some OSes report an empty/generic type for .webp etc., so fall
        // back to the extension (the probe <img> below rejects non-images).
        var looksImage = /^image\//.test(file.type || '') || /\.(png|gif|webp|jpe?g|apng|avif|svg)$/i.test(file.name || '');
        if (!looksImage) { this._setStatus('Stamps must be images'); return; }
        var url = URL.createObjectURL(file);
        var probe = new Image();
        probe.onload = function () {
          var nw = probe.naturalWidth || 100, nh = probe.naturalHeight || 100;
          URL.revokeObjectURL(url);
          self._uploadFileEntry(file, function (err, entry) {
            if (err) return;
            self._backStamps.push(self._makeStamp(entry.objId, nw, nh));
            self._selectedStampIdx = self._backStamps.length - 1;
            self._showBackView(true);
            // Not a ProseMirror transaction, so nothing else would trigger
            // an autosave for this.
            self._markEdited();
            self._setStatus('Stamp added');
          });
        };
        probe.onerror = function () {
          URL.revokeObjectURL(url);
          self._setStatus('Could not read image');
        };
        probe.src = url;
      },

      // Natural size -> capped stamp record, centered with a small stagger
      // so successive stamps don't land exactly on top of each other.
      _makeStamp: function (objId, nw, nh) {
        var scale = Math.min(1, this._STAMP_MAX_W / nw, this._STAMP_MAX_H / nh);
        var w = (nw * scale) / this._BACK_W;
        var ar = nw / nh;
        var hFrac = (w * this._BACK_W / ar) / this._BACK_H;
        var n = this._backStamps.length % 5;
        return {
          objId: objId,
          x: Math.max(0, Math.min(1 - w, (1 - w) / 2 + 0.03 * n)),
          y: Math.max(0, Math.min(1 - hFrac, (1 - hFrac) / 2 + 0.03 * n)),
          w: w,
          ar: ar,
        };
      },

      _resolveStampSrc: function (stamp, cb) {
        var entry = (this._attachments || []).filter(function (a) { return a.objId === stamp.objId; })[0];
        if (!entry) return cb(null, '');
        if (!entry.dek) return cb(null, this._publicBlobUrl(entry.blobCid));
        lively.identity.fileCrypto.resolveAttachmentUrl(this._handle, entry, cb);
      },

      _refreshBackStamps: function () {
        var self = this;
        var layer = this._stampLayer;
        layer.innerHTML = '';
        this._stampEls = [];
        function pct(f) { return (f * 100) + '%'; }

        this._backStamps.forEach(function (stamp, i) {
          var wrap = document.createElement('div');
          wrap.setAttribute('role', 'button');
          wrap.setAttribute('aria-label', 'Stamp ' + (i + 1) + ' (drag to move)');
          wrap.style.cssText = 'position:absolute;left:' + pct(stamp.x) + ';top:' + pct(stamp.y) +
            ';width:' + pct(stamp.w) + ';cursor:grab;touch-action:none;user-select:none;';
          var img = document.createElement('img');
          img.draggable = false;
          img.alt = 'Stamp';
          img.style.cssText = 'display:block;width:100%;height:auto;-webkit-user-drag:none;pointer-events:none;';
          wrap.appendChild(img);
          self._resolveStampSrc(stamp, function (err, src) {
            if (!err && src) img.src = src;
          });

          var chip = document.createElement('button');
          chip.textContent = 'close';
          chip.title = 'Remove stamp';
          chip.style.cssText = [
            'position:absolute', 'top:2px', 'right:2px', 'width:18px', 'height:18px', 'padding:0',
            'border:none', 'border-radius:50%', 'background:#E31361', 'color:#fff', 'cursor:pointer',
            'font-family:"Material Symbols Rounded"', 'font-size:13px', 'line-height:18px',
            'display:none', 'text-align:center',
          ].join(';');
          chip.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
          chip.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            self._removeStamp(i);
          });
          wrap.appendChild(chip);

          wrap.addEventListener('pointerdown', function (e) {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            self._selectStamp(i);
            var scale = (self._backFace.getBoundingClientRect().width / self._BACK_W) || 1;
            var startX = e.clientX, startY = e.clientY, ox = stamp.x, oy = stamp.y, moved = false;
            var hFrac = (stamp.w * self._BACK_W / stamp.ar) / self._BACK_H;
            wrap.setPointerCapture(e.pointerId);
            wrap.style.cursor = 'grabbing';
            function onMove(ev) {
              var dx = (ev.clientX - startX) / scale / self._BACK_W;
              var dy = (ev.clientY - startY) / scale / self._BACK_H;
              stamp.x = Math.max(0, Math.min(1 - stamp.w, ox + dx));
              stamp.y = Math.max(0, Math.min(1 - hFrac, oy + dy));
              wrap.style.left = pct(stamp.x);
              wrap.style.top = pct(stamp.y);
              moved = true;
            }
            function onUp() {
              document.removeEventListener('pointermove', onMove, true);
              document.removeEventListener('pointerup', onUp, true);
              document.removeEventListener('pointercancel', onUp, true);
              wrap.style.cursor = 'grab';
              if (moved) self._markEdited();
            }
            // Listen on document in the capture phase, not on the stamp:
            // Lively's own capture-phase pointer/mouse handlers sit between
            // document and the stamp and swallow the move/up events before
            // they reach it (confirmed live — a listener on the stamp itself
            // never fired, one on document capture did).
            document.addEventListener('pointermove', onMove, true);
            document.addEventListener('pointerup', onUp, true);
            document.addEventListener('pointercancel', onUp, true);
          });

          layer.appendChild(wrap);
          self._stampEls.push({ wrap: wrap, chip: chip });
        });
        this._selectStamp(this._selectedStampIdx);
      },

      _selectStamp: function (idx) {
        this._selectedStampIdx = idx;
        (this._stampEls || []).forEach(function (s, i) {
          var sel = i === idx;
          s.wrap.style.outline = sel ? '2px dashed #E31361' : 'none';
          s.wrap.style.outlineOffset = '2px';
          s.chip.style.display = sel ? 'block' : 'none';
        });
      },

      _removeStamp: function (idx) {
        var stamp = this._backStamps[idx];
        if (!stamp) return;
        this._backStamps.splice(idx, 1);
        this._selectedStampIdx = -1;
        // Drop the uploaded entry too (and its dek) unless something else —
        // another stamp, or an inline image/link in the doc — still uses it.
        var objId = stamp.objId;
        var stillUsed = this._backStamps.some(function (s) { return s.objId === objId; }) ||
          (this.editorView && JSON.stringify(this.editorView.state.doc.toJSON()).indexOf(objId) !== -1);
        if (!stillUsed) {
          this._attachments = (this._attachments || []).filter(function (a) { return a.objId !== objId; });
        }
        this._refreshBackStamps();
        this._markEdited();
      },

    },

    // ─── auto-save ────────────────────────────────────────────────────────────────

    'autosave', {

      _scheduleSave: function () {
        if (!this._userHasEdited) return; // skip ySyncPlugin init transaction
        var self = this;
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(function () { self._saveNow(); }, 2000);
        this._setStatus('…');
      },

      _markEdited: function () {
        // Belt-and-suspenders: _applyReadOnlyMode already makes the
        // ProseMirror view non-editable when !_canEdit, so this shouldn't
        // fire from real user input in that case — but unlike a plain card
        // (owner-only server-side, no exceptions), a wiki-mode PUT can
        // legitimately succeed for a non-owner constellation member
        // (§16.6), so this check has to mirror _canEdit's fuller condition,
        // not just ownership, or it would block a save the server would
        // actually accept.
        if (!this._canEdit) return;
        this._userHasEdited = true;
        this._scheduleSave();
      },

      // callback: optional (err) — invoked after PUT completes/fails, in
      // addition to the normal status-line feedback. Used by _doSend to wait
      // for a reseal-save to finish before notifying the recipient.
      //
      // Saves are serialized: a save requested while another is still in
      // flight (the first one can sit on a WebAuthn ceremony for many
      // seconds) waits for it, then runs once more so it builds on the
      // envelope that save produced. Without this the second save started
      // from the same stale `this._envelope` -- null for a brand-new card, so
      // it minted a SECOND genesis objId and the card was created twice; for
      // an existing card it chained off the same prevCid and was rejected
      // with a 409. Everything requested during the wait coalesces into one
      // re-run, and each caller's callback fires after the save that covers
      // its edits (so _doSend's reseal still sees the stored recipients).
      _saveNow: function (callback) {
        clearTimeout(this._saveTimer);
        var self = this;
        // _saveInFlight holds the start time rather than true: a save whose
        // chain never calls back (an exception mid-serialize) would otherwise
        // wedge every later autosave, so a flag older than 2 minutes is
        // treated as dead.
        if (this._saveInFlight && Date.now() - this._saveInFlight < 120000) {
          this._saveRerun = true;
          if (callback) (this._saveWaiters = this._saveWaiters || []).push(callback);
          return;
        }
        var cb = function (err) {
          self._saveInFlight = false;
          var waiters = self._saveWaiters || [];
          var rerun = self._saveRerun;
          self._saveWaiters = null;
          self._saveRerun = false;
          if (callback) callback(err);
          if (!rerun) return;
          // A failed save (e.g. a cancelled passkey prompt) isn't retried
          // here -- that would re-prompt immediately. Waiters hear the error;
          // the next edit schedules a fresh save as usual.
          if (err) return waiters.forEach(function (w) { w(err); });
          self._saveNow(function (err2) { waiters.forEach(function (w) { w(err2); }); });
        };
        var user = lively.identity.did.currentUser();
        if (!user) { this._setStatus('Not signed in'); return cb(new Error('Not signed in')); }
        // Plain mode (§1.1) has no yDoc at all — the editorView existing is
        // the actual "is there a document to save" signal for either mode.
        if (!this.editorView) { this._setStatus('No document'); return cb(new Error('No document')); }
        this._saveInFlight = Date.now();
        this._docJsonAtSave = this._currentDocJson();

        if (this._visibility === 'public') return this._saveNowPublic(user, cb);
        this._saveNowPrivate(user, cb);
      },

      _saveNowPublic: function (user, callback) {
        var self = this;
        var cb = callback || function () {};
        var params = {
          prevEnvelope:  this._envelope || null,
          constellation: this._constellation,
          visibility:    'public',
          attachments:   this._attachments || [],
          stateMeta:     this._composeStateMeta(),
          // title omitted unless the author set one — PostCardSerializer extracts it from the first PM block (§10.5)
        };
        var explicitTitle = (this._title || '').trim();
        if (explicitTitle) { params.title = explicitTitle; params.titleExplicit = true; }
        var serialize;
        if (this._isWikiMode) {
          params.yDoc = this.yDoc;
          serialize = lively.identity.postCardSerializer.serializeToEnvelope;
        } else {
          params.doc = this.editorView.state.doc.toJSON();
          params.partState = this._partState || {};
          params.backStamps = this._backStamps || [];
          if (this._game) params.game = this._game;
          serialize = lively.identity.postCardSerializer.serializePlainToEnvelope;
        }
        this._setStatus('Saving…');
        serialize.call(lively.identity.postCardSerializer, params, function (err, envelope) {
          self._finishSave(err, envelope, cb);
        });
      },

      // Private/shared save: cache the KEK for this session (one WebAuthn
      // prompt), work out who the card is sealed to, re-resolve every
      // recipient's current public key (their key may have changed since the
      // last save, and serializeEncrypted always reseals a fresh DEK for the
      // full recipient list — there is no persistent DEK across versions),
      // then encrypt.
      _saveNowPrivate: function (user, callback) {
        var self = this;
        var cb = callback || function () {};
        var wa = lively.identity.webAuthn;
        this._setStatus('Saving…');

        function withKek(cb2) {
          if (wa._kekCache && wa._kekCache[user.credentialId]) return cb2(null);
          self._setStatus('Confirm passkey…');
          var ch = new Uint8Array(32);
          crypto.getRandomValues(ch);
          wa.deriveKek({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err) { cb2(err); });
        }

        function fail(status, err) {
          console.error('[PostCardEditor] ' + status + ':', err && err.message);
          self._setStatus('Error (' + status + ')');
          cb(err);
        }

        withKek(function (err) {
          if (err) return fail('passkey', err);
          // The recorded audience decides who the new version is sealed to, so it
          // has to be known first: sealing to the handle list alone would withdraw
          // everyone a card was shared with through its audience.
          self._ensureAudienceLoaded(function (loadErr) {
            if (loadErr) return fail('audience', loadErr);
            self._sealTargetHandles(function (targetErr, handles) {
              if (targetErr) return fail('audience', targetErr);
              self._resolveRecipientPubKeys(handles, function (_e, result) {
                if (result.failed.length) {
                  console.warn('[PostCardEditor] Dropping recipient(s) with no published key from this save:', result.failed.join(', '));
                }
                self._lastSealedHandles = result.resolved.map(function (r) { return r.handle; });
                // An audience card records the coarse shape of its audience (what a
                // recipient may see); a card shared by handle records the handles.
                var meta = self._audience
                  ? { audience: lively.identity.AudienceRules.mirrorFor(self._audience) }
                  : { recipientHandles: self._lastSealedHandles };
                var title = (self._title || '').trim();
                var params = {
                  prevEnvelope:  self._envelope || null,
                  constellation: self._constellation,
                  title:         title || undefined,
                  titleExplicit: !!title,
                  recipients:    result.resolved.map(function (r) {
                    return { did: r.did, x25519PublicKey: r.x25519PublicKey };
                  }),
                  attachments: self._attachments || [],
                  stateMeta: self._composeStateMeta(meta),
                };
                var serialize;
                if (self._isWikiMode) {
                  params.yDoc = self.yDoc;
                  serialize = lively.identity.postCardSerializer.serializeEncrypted;
                } else {
                  params.doc = self.editorView.state.doc.toJSON();
                  params.partState = self._partState || {};
                  params.backStamps = self._backStamps || [];
                  if (self._game) params.game = self._game;
                  serialize = lively.identity.postCardSerializer.serializePlainEncrypted;
                }
                serialize.call(lively.identity.postCardSerializer, params, function (serErr, envelope) {
                  self._finishSave(serErr, envelope, cb);
                });
              });
            });
          });
        });
      },

      // Resolve each handle to { did, handle, x25519PublicKey }, cached
      // per-session so repeated autosaves of a shared card don't refetch
      // every recipient's profile on every 2s debounce tick. Cache entries
      // expire after RECIPIENT_KEY_CACHE_TTL_MS so a key rotated by a
      // recipient mid-session is eventually picked up rather than never
      // (postcard-audit F25) — long enough to still absorb the debounce
      // storm, short enough to not go stale for an editor left open a while.
      // Calls thenDo(null, { resolved: [...], failed: [handle, ...] }).
      _resolveRecipientPubKeys: function (handles, thenDo) {
        var self = this;
        if (!handles || !handles.length) return thenDo(null, { resolved: [], failed: [] });
        if (!this._recipientPubKeyCache) this._recipientPubKeyCache = {};

        var base = lively.identity.did.baseUrl();
        var resolved = [];
        var failed = [];
        var remaining = handles.length;
        var now = Date.now();

        function done() {
          if (--remaining === 0) thenDo(null, { resolved: resolved, failed: failed });
        }

        handles.forEach(function (handle) {
          var cached = self._recipientPubKeyCache[handle];
          if (cached && (now - cached.at) < RECIPIENT_KEY_CACHE_TTL_MS) {
            resolved.push(cached.entry);
            return done();
          }

          lively.identity.webKey.resolveHandle(handle, function (err, info) {
            if (err || !info || !info.did) { failed.push(handle); return done(); }
            var xhr = new XMLHttpRequest();
            xhr.open('GET', base + '/@' + encodeURIComponent(handle) + '/profile', true);
            xhr.withCredentials = true;
            xhr.onload = function () {
              if (xhr.status !== 200) { failed.push(handle); return done(); }
              var env;
              try { env = JSON.parse(xhr.responseText); } catch (e) { failed.push(handle); return done(); }
              var pub = env.record && env.record.payload && env.record.payload.accountX25519Pub;
              if (!pub) { failed.push(handle); return done(); }

              // Integrity check (postcard-audit F22): every other envelope
              // consumer in this codebase verifies record.cid before trusting
              // record.payload; this was the one that didn't, despite the
              // payload feeding straight into who a DEK gets sealed to. This
              // only catches accidental corruption / a CID that doesn't match
              // its own payload — it does not by itself prove the payload is
              // the real recipient's, since a malicious server can compute a
              // matching CID for a substituted payload too. Full protection
              // needs signature verification against the recipient's
              // delegated device key (see the envelope-signing added in
              // RegisterDialog.js/UserSpace.js), which isn't wired up yet —
              // tracked as the F20/F22 verifier follow-up.
              lively.identity.crypto.computeCid(env.record.payload, function (cidErr, expectedCid) {
                if (cidErr || expectedCid !== env.record.cid) {
                  console.warn('[PostCardEditor] Profile envelope for @' + handle +
                    ' failed CID integrity check — refusing to seal to its accountX25519Pub');
                  failed.push(handle);
                  return done();
                }
                var entry = { did: info.did, handle: handle, x25519PublicKey: pub };
                self._recipientPubKeyCache[handle] = { entry: entry, at: Date.now() };
                resolved.push(entry);
                done();
              });
            };
            xhr.onerror = function () { failed.push(handle); done(); };
            xhr.send();
          });
        });
      },

      _finishSave: function (err, envelope, callback) {
        var self = this;
        var cb = callback || function () {};
        if (err) {
          console.error('[PostCardEditor] serialize error:', err && (err.message || String(err)));
          self._setStatus('Error');
          return cb(err);
        }
        self._putEnvelope(envelope, function (putErr) {
          if (putErr) {
            console.error('[PostCardEditor] PUT error:', putErr && (putErr.message || String(putErr)));
            self._setStatus('Error');
            return cb(putErr);
          }
          self._envelope = envelope;
          self._objId = envelope.objId;
          self._savedDocJson = self._docJsonAtSave === undefined ? self._savedDocJson : self._docJsonAtSave;
          self._audienceChangePending = false;
          self._titleChangePending = false;
          // A card with a recorded audience is sealed from that, not from a handle
          // list, so what the envelope names must not turn into a sticky list.
          if (!self._audience) {
            self._recipientHandles = (envelope.state && envelope.state.recipientHandles) || self._recipientHandles;
          }
          self._locationCode = (envelope.state && envelope.state.location) || null;
          self._locationCleared = false;
          self._updateLocationBtn();
          self._reactionsEnabled = !(envelope.state && envelope.state.reactionsEnabled === false);
          self._updateVisibilityBtn();
          // An audience chosen before the card existed can only be recorded now that
          // it has an objId. A failure keeps the flag, so the next save tries again.
          if (self._audienceDirty && envelope.objId) {
            lively.identity.postcardAudience.setCardAudience(
              envelope.objId, self._visibility === 'public' ? null : self._audience,
              function (recErr) {
                if (recErr) return $world.alert('Saved the card, but could not record who it is shared with: ' + recErr.message);
                self._audienceDirty = false;
              });
          }
          self._shareAttachmentsWithAudience();
          // If this was a new card, wire up sync now that we have an objId
          if (self._isNew) {
            self._isNew = false;
            self._connectSync();
          }
          self._setStatus('Saved');
          cb(null);
        });
      },

      _putEnvelope: function (envelope, callback) {
        var base = lively.identity.did.baseUrl();
        var url = base + '/@' + encodeURIComponent(this._handle) + '/' + encodeURIComponent(envelope.objId);
        console.log('[PostCardEditor] PUT', url, 'objId:', envelope.objId);
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status === 200 || xhr.status === 201) return callback(null);
          console.error('[PostCardEditor] PUT failed', xhr.status, xhr.responseText.slice(0, 300));
          callback(new Error('PUT failed: ' + xhr.status));
        };
        xhr.onerror = function () {
          console.error('[PostCardEditor] PUT network error');
          callback(new Error('Network error'));
        };
        xhr.send(JSON.stringify(envelope));
      },

    },

    // ─── constellation posting ──────────────────────────────────────────────────
    // "Post to a constellation": tags this card with that constellation (so
    // it shows in its feed, same field the original constellation stub
    // routes already read) and places it in the constellation's live space
    // at a default position — server-side, see POST /c/:name/posts.

    'constellation', {

      // thenDo(err) — mirrors _doSend's shape. Posts the card to the named
      // constellation (server requires membership) and, on success, remembers
      // it in the same localStorage list ConstellationsBrowser.js reads
      // (lively.identity.knownConstellations), so it shows up there too and
      // in this panel's datalist next time.
      _doSendToConstellation: function (name, thenDo) {
        if (!this._objId) return thenDo(new Error('Save the card before sending'));
        var objId = this._objId;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open('POST', base + '/c/' + encodeURIComponent(name) + '/posts', true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function () {
          if (xhr.status !== 200) {
            var msg = 'Post failed (' + xhr.status + ')';
            try {
              var body = JSON.parse(xhr.responseText);
              if (body && body.error) msg = body.error;
            } catch (e) {}
            return thenDo(new Error(msg));
          }
          try {
            var key = 'lively.identity.knownConstellations';
            var known = JSON.parse(localStorage.getItem(key) || '[]').filter(function (k) { return k.name !== name; });
            known.unshift({ name: name, at: new Date().toISOString() });
            localStorage.setItem(key, JSON.stringify(known.slice(0, 30)));
          } catch (e) {}
          thenDo(null);
        };
        xhr.onerror = function () { thenDo(new Error('Network error')); };
        xhr.send(JSON.stringify({ objId: objId }));
      },

      // Best-effort fill of the "c/constellation" tab's autocomplete: the
      // locally-remembered list (same source ConstellationsBrowser.js uses)
      // synchronously, plus the server's public directory merged in async —
      // never blocks opening the panel.
      _populateKnownConstellations: function (datalistEl) {
        var seen = {};
        function addOption(name) {
          if (!name || seen[name]) return;
          seen[name] = true;
          var opt = document.createElement('option');
          opt.value = name;
          datalistEl.appendChild(opt);
        }
        try {
          JSON.parse(localStorage.getItem('lively.identity.knownConstellations') || '[]')
            .forEach(function (k) { addOption(k.name); });
        } catch (e) {}

        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open('GET', base + '/c', true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.onload = function () {
          if (xhr.status !== 200) return;
          try {
            var data = JSON.parse(xhr.responseText);
            (data.constellations || []).forEach(function (c) { addOption(c.name); });
          } catch (e) {}
        };
        xhr.send();
      },

    },

    // ─── audience ─────────────────────────────────────────────────────────────────
    // Who can open a private card. The owner picks it in the audience dialog
    // (the same one the homestar reel uses); it is recorded in the owner's
    // settings (state.cardAudiences) and every save seals the new version to it,
    // expanded against the friends, orbit and lists as they are at that moment.

    'audience', {

      // owner only. fresh: load again even if the copy is recent. thenDo(err, ctx).
      _ensureAudienceCtx: function (fresh, thenDo) {
        var self = this;
        if (!fresh && this._audienceCtx && (Date.now() - this._audienceCtxAt) < AUDIENCE_CTX_TTL_MS) {
          return thenDo(null, this._audienceCtx);
        }
        lively.identity.postcardAudience.loadContext(function (err, ctx) {
          if (!err) { self._audienceCtx = ctx; self._audienceCtxAt = Date.now(); }
          thenDo(err, ctx);
        });
      },

      // Reads the audience recorded for this card. A card that has no objId yet has
      // nothing recorded. Saving a private card before this has happened could
      // seal it to the wrong people, so _saveNowPrivate waits for it.
      _ensureAudienceLoaded: function (thenDo) {
        var self = this;
        if (this._audienceLoaded || !this._objId) return thenDo(null);
        this._ensureAudienceCtx(true, function (err, ctx) {
          if (err) return thenDo(err);
          if (!self._audienceLoaded) {   // the dialog may have set it while this was loading
            self._audience = ctx.cardAudiences[self._objId] || null;
            self._audienceLoaded = true;
          }
          self._updateVisibilityBtn();
          thenDo(null);
        });
      },

      // Applies what newCard was given to start from (opts.game, opts.text, opts.audience),
      // once the editor view exists. Runs once. It changes the editor's state but SAVES
      // NOTHING and does not count as an edit:
      //  - the audience is set exactly as the audience dialog does for a card with no objId
      //    yet (private, recorded after the first save), so the card is created sealed to it;
      //  - the text goes in as a transaction marked 'prefill', which dispatchTransaction does
      //    not treat as an edit, so no autosave starts;
      //  - the game block is held in _game and goes out with the first save.
      // The card therefore comes into existence only when its author edits it or saves it,
      // never because another feature opened the editor.
      _applyPrefill: function () {
        var p = this._pendingPrefill;
        if (!p) return;
        this._pendingPrefill = null;
        if (p.game) this._game = p.game;
        if (p.audience) {
          this._visibility = 'private';
          this._audience = p.audience;
          this._audienceLoaded = true;
          this._audienceDirty = true;
          this._updateVisibilityBtn();
        }
        // p.text: one paragraph as a string, or several as an array of strings.
        var paras = (Array.isArray(p.text) ? p.text : [p.text]).filter(function (t) { return t; });
        if (paras.length && this.editorView) {
          var view = this.editorView;
          var schema = view.state.schema;
          var nodes = paras.map(function (t) { return schema.nodes.paragraph.create(null, schema.text(String(t))); });
          view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, nodes).setMeta('prefill', true));
        }
      },

      // The handles of everyone besides the owner the card is to be sealed to: the
      // recorded audience expanded now, or the flat handle list of a card shared
      // before audiences existed, plus anyone a Send in progress adds.
      // thenDo(err, handles)
      _sealTargetHandles: function (thenDo) {
        var self = this;
        var extra = this._extraRecipientHandles || [];
        function withExtra(list) {
          var out = list.slice();
          extra.forEach(function (h) { if (out.indexOf(h) === -1) out.push(h); });
          return out;
        }
        if (!this._audience) return thenDo(null, withExtra(this._recipientHandles || []));
        this._ensureAudienceCtx(false, function (err, ctx) {
          if (err) return thenDo(err);
          var handles = [];
          lively.identity.AudienceRules.unionDids(self._audience, ctx).forEach(function (did) {
            if (ctx.handleByDid[did]) handles.push(ctx.handleByDid[did]);
          });
          thenDo(null, withExtra(handles));
        });
      },

      // The audience button. Public <-> private is a content change (a new plaintext
      // or encrypted version), which is why it is chosen here and not on the reel.
      _openAudienceDialog: function () {
        var self = this;
        if (!this._canEdit || this._sentLocked) return;
        this._ensureAudienceCtx(true, function (err, ctx) {
          if (err) return $world.alert('Could not load your friends and lists: ' + err.message);
          self._ensureAudienceLoaded(function (loadErr) {
            if (loadErr) return $world.alert('Could not read who this card is shared with: ' + loadErr.message);
            var audience = self._audience;
            var warning = null;
            var env = self._envelope;
            if (!audience && self._visibility !== 'public' && env) {
              // Shared by handle before audiences existed: start from the friends it
              // is already sealed to. Anyone else it names would lose access on save.
              var dids = ((env.record && env.record.recipients) || []).map(function (r) { return r.did; });
              var friends = dids.filter(function (d) { return ctx.friendDids.indexOf(d) !== -1; });
              audience = { tiers: [], people: friends };
              var lost = dids.length - friends.length;
              if (lost > 0) {
                warning = lost + (lost === 1 ? ' person who is' : ' people who are') + ' not your ' +
                  (lost === 1 ? 'friend' : 'friends') + ' will lose access if you save.';
              }
            }
            lively.identity.AudienceDialog.open({
              ctx: ctx,
              audience: audience,
              isPublic: self._visibility === 'public',
              allowPublic: true,
              subtitle: (env && env.state && env.state.title) || 'This postcard',
              warning: warning,
              onSave: function (result) { self._applyAudienceResult(result); },
            });
          });
        });
      },

      // result = { pub, audience: { tiers, people } } from the dialog. Records the
      // choice, then saves a new version sealed to it (or published, for Public).
      _applyAudienceResult: function (result) {
        var self = this;
        var nowPublic = !!result.pub;
        var audience = nowPublic ? null : result.audience;
        var same = (this._visibility === 'public') === nowPublic &&
          JSON.stringify(this._audience || null) === JSON.stringify(audience);
        if (same) return;

        function apply() {
          self._visibility = nowPublic ? 'public' : 'private';
          self._audience = audience;
          self._audienceLoaded = true;
          self._updateVisibilityBtn();
          self._userHasEdited = true;
          // A card that exists is re-saved now so the change takes effect; a new
          // one saves as usual once it has content.
          if (self._objId) self._audienceChangePending = true;
          if (self._objId) self._saveNow();
          else self._scheduleSave();
        }

        if (!this._objId) {
          this._audienceDirty = true;   // recorded after the first save, when there is an objId
          return apply();
        }
        // Record the intent first, so a failed save can still be retried from it.
        lively.identity.postcardAudience.setCardAudience(this._objId, audience, function (err) {
          if (err) return $world.alert('Could not save the audience: ' + err.message);
          apply();
        });
      },

      // A shared attachment's own blob needs the same people on its access list as
      // the card (the key to open it travels inside the card). Done once per person
      // per set of attachments, not on every autosave; non-fatal, see
      // _grantAttachmentsAccess.
      _shareAttachmentsWithAudience: function () {
        var self = this;
        if (this._visibility === 'public' || !(this._attachments || []).length) return;
        var key = (this._attachments || []).map(function (a) { return a.objId; }).join(',');
        (this._lastSealedHandles || []).forEach(function (h) {
          if (self._grantedAttachments[h] === key) return;
          self._grantedAttachments[h] = key;
          self._grantAttachmentsAccess(h, function () {});
        });
      },

    },

    // ─── send ─────────────────────────────────────────────────────────────────────
    // Per spec §2.3, sending = grant access (reseal the DEK to include the
    // recipient, for private/shared cards) + POST /@:handle/inbox to notify
    // them. A public card just gets the notify — anyone can already read it.

    'send', {

      // initialTab: 'handle' (default) or 'constellation' — which Send-to
      // tab to land on. If the panel is already open: re-requesting its
      // current tab toggles it closed (mirrors the old single-purpose panel's
      // toggle behavior); requesting the other tab just switches to it. Who can
      // read the card is chosen with the audience button, not here.
      _promptAndSend: function (initialTab) {
        var tab = initialTab === 'constellation' ? 'constellation' : 'handle';
        if (this._sendPanel) {
          if (this._sendPanelTab !== tab) {
            this._selectSendTab(tab);
            return;
          }
          this._closeSendPanel();
          return;
        }
        this._sendPendingTab = tab;
        this._openSendModal();
        this._renderSendToStep(tab);
      },

      // Native overlay on top of a Lively world: must live outside any
      // morph's own DOM subtree (shapeNode) or typing into its inputs
      // silently fails — see CLAUDE.md. One backdrop+panel shell is reused
      // across the panel's tabs, so listeners bound to the panel itself
      // (stopPropagation, Escape) are attached once here.
      _openSendModal: function () {
        var self = this;
        var backdrop = document.createElement('div');
        backdrop.style.cssText = [
          'position:fixed', 'top:0', 'left:0', 'right:0', 'bottom:0',
          'background:rgba(0,0,0,0.25)', 'z-index:9998',
        ].join(';');
        backdrop.addEventListener('mousedown', function (e) {
          if (e.target === backdrop) self._closeSendPanel();
        });

        var panel = document.createElement('div');
        panel.style.cssText = [
          'position:fixed', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
          'width:280px', 'background:#fff', 'border:1px solid #ccc', 'border-radius:8px',
          'box-shadow:0 8px 28px rgba(0,0,0,0.28)', 'padding:14px',
          'z-index:9999', 'box-sizing:border-box', 'font-family:sans-serif',
        ].join(';');
        ['keydown', 'keyup', 'keypress', 'mousedown', 'mousemove', 'mouseup', 'click'].forEach(function (t) {
          panel.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        panel.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') self._closeSendPanel();
        });

        document.body.appendChild(backdrop);
        document.body.appendChild(panel);
        this._sendPanel = panel;
        this._sendBackdrop = backdrop;
      },

      // @handle / c/constellation destination tabs.
      _renderSendToStep: function (tab) {
        var self = this;
        var panel = this._sendPanel;
        while (panel.firstChild) panel.removeChild(panel.firstChild);

        var audienceLine = document.createElement('div');
        audienceLine.style.cssText = 'font-size:10px;color:#888;margin-bottom:8px;';
        audienceLine.appendChild(document.createTextNode('Who can read it now: ' + this._audienceLabel() + ' · '));
        var changeLink = document.createElement('span');
        changeLink.textContent = 'change';
        changeLink.style.cssText = 'cursor:pointer;text-decoration:underline;';
        changeLink.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._closeSendPanel();
          self._openAudienceDialog();
        });
        audienceLine.appendChild(changeLink);
        panel.appendChild(audienceLine);

        var title = document.createElement('div');
        title.textContent = 'Send to';
        title.style.cssText = 'font-size:13px;font-weight:700;margin-bottom:10px;color:#222;';
        panel.appendChild(title);

        var tabBar = document.createElement('div');
        tabBar.style.cssText = 'display:flex;gap:4px;margin-bottom:10px;border-bottom:1px solid #eee;';
        var handleTab = document.createElement('button');
        handleTab.textContent = '@handle';
        var constTab = document.createElement('button');
        constTab.textContent = 'c/constellation';
        [handleTab, constTab].forEach(function (t) {
          t.style.cssText = 'flex:1;font-size:11px;padding:6px 4px;cursor:pointer;border:none;border-bottom:2px solid transparent;background:transparent;color:#888;';
        });
        handleTab.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._selectSendTab('handle');
        });
        constTab.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._selectSendTab('constellation');
        });
        tabBar.appendChild(handleTab);
        tabBar.appendChild(constTab);
        panel.appendChild(tabBar);

        var handleSection = document.createElement('div');
        var constSection = document.createElement('div');
        panel.appendChild(handleSection);
        panel.appendChild(constSection);

        // ── @handle tab ──
        var handleLabel = document.createElement('div');
        handleLabel.textContent = 'Send to @handle';
        handleLabel.style.cssText = 'font-size:11px;color:#666;margin-bottom:6px;';
        handleSection.appendChild(handleLabel);

        // Sending is the one irreversible way to hand a card over; sharing with an
        // audience is not. Say so before the button, not after.
        var permanentNote = document.createElement('div');
        permanentNote.textContent = 'Sending puts the card in their inbox and freezes it: you won\u2019t be able to edit it afterward. ' +
          'To share it and keep editing, use the audience button instead.';
        permanentNote.style.cssText = 'font-size:11px;line-height:1.35;color:#7a4b00;background:#fff6e0;' +
          'border:1px solid #f0d9a0;border-radius:4px;padding:6px 8px;margin-bottom:8px;';
        handleSection.appendChild(permanentNote);

        var handleInput = document.createElement('input');
        handleInput.type = 'text';
        handleInput.placeholder = 'handle (no @)';
        handleInput.style.cssText = 'width:100%;box-sizing:border-box;font-size:12px;padding:5px 7px;border:1px solid #ccc;border-radius:3px;margin-bottom:6px;';
        // Recipient preset (see newCard) — prefill rather than auto-send,
        // so the recipient is still a step the user confirms by clicking
        // Send.
        if (self._presetRecipient) handleInput.value = self._presetRecipient;
        handleSection.appendChild(handleInput);

        var handleMsg = document.createElement('div');
        handleMsg.style.cssText = 'font-size:11px;color:#999;min-height:14px;margin-bottom:6px;';
        handleSection.appendChild(handleMsg);

        var handleBtnRow = document.createElement('div');
        handleBtnRow.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';
        var handleCancelBtn = document.createElement('button');
        handleCancelBtn.textContent = 'Cancel';
        handleCancelBtn.style.cssText = 'font-size:11px;padding:4px 10px;cursor:pointer;border:1px solid #ccc;border-radius:3px;background:#fff;';
        handleCancelBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._closeSendPanel();
        });
        handleBtnRow.appendChild(handleCancelBtn);

        // Live encryption-status hint as the handle is typed, for private/shared
        // cards only — surfaces "hasn't set up encryption yet" up front rather
        // than only after a failed Send attempt (the failure path below still
        // applies as a safety net; this is purely informational and doesn't
        // block clicking Send).
        var checkTimer = null;
        if (this._visibility !== 'public') {
          handleInput.addEventListener('input', function () {
            clearTimeout(checkTimer);
            var handle = handleInput.value.trim().replace(/^@/, '');
            if (!handle) { handleMsg.textContent = ''; return; }
            handleMsg.textContent = 'Checking…';
            handleMsg.style.color = '#999';
            checkTimer = setTimeout(function () {
              lively.identity.webKey.resolveHandle(handle, function (err, info) {
                if (handleInput.value.trim().replace(/^@/, '') !== handle) return; // stale — input changed since
                if (err || !info || !info.did) {
                  handleMsg.textContent = 'Handle not found';
                  handleMsg.style.color = '#c33';
                  return;
                }
                if (lively.identity.did.isBlocked(info.did, handle)) {
                  handleMsg.textContent = "You've blocked @" + handle;
                  handleMsg.style.color = '#c33';
                  sendBtn.disabled = true;
                  return;
                }
                sendBtn.disabled = false;
                self._resolveRecipientPubKeys([handle], function (_e, result) {
                  if (handleInput.value.trim().replace(/^@/, '') !== handle) return; // stale
                  var canSeal = result.resolved.length > 0;
                  handleMsg.textContent = '';
                  handleMsg.appendChild(lively.identity.postCardUtils.lockGlyph({ size: 14, open: !canSeal }));
                  handleMsg.appendChild(document.createTextNode(canSeal ? ' can receive encrypted cards' : " hasn't set up encryption yet"));
                  handleMsg.style.color = canSeal ? '#2a2' : '#c60';
                });
              });
            }, 400);
          });
        }

        var sendBtn = document.createElement('button');
        sendBtn.textContent = 'Send & Freeze';
        sendBtn.style.cssText = 'font-size:11px;padding:4px 10px;cursor:pointer;border:1px solid #E31361;border-radius:3px;background:#fde6ee;';
        function submitHandle() {
          var handle = handleInput.value.trim().replace(/^@/, '');
          if (!handle) { handleMsg.textContent = 'Enter a handle'; handleMsg.style.color = '#c33'; return; }
          sendBtn.disabled = true;
          handleMsg.textContent = 'Sending…';
          handleMsg.style.color = '#888';
          self._doSend(handle, function (err, result) {
            sendBtn.disabled = false;
            if (err) { handleMsg.textContent = err.message || 'Failed'; handleMsg.style.color = '#c33'; return; }
            if (result && result.returned) {
              handleMsg.textContent = 'Not delivered (blocked, or handle unknown)';
              handleMsg.style.color = '#c33';
              return;
            }
            handleMsg.textContent = 'Sent to @' + handle;
            handleMsg.style.color = '#2a2';
            self._updateVisibilityBtn();
            setTimeout(function () { self._closeEditor(); }, 800);
          });
        }
        sendBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          submitHandle();
        });
        handleBtnRow.appendChild(sendBtn);
        handleSection.appendChild(handleBtnRow);
        handleInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') submitHandle();
        });

        // ── c/constellation tab ──
        var constLabel = document.createElement('div');
        constLabel.textContent = 'Post to a constellation you’re a member of';
        constLabel.style.cssText = 'font-size:11px;color:#666;margin-bottom:6px;';
        constSection.appendChild(constLabel);

        var constInput = document.createElement('input');
        constInput.type = 'text';
        constInput.placeholder = 'constellation name';
        constInput.setAttribute('list', 'postcardKnownConstellations');
        constInput.style.cssText = 'width:100%;box-sizing:border-box;font-size:12px;padding:5px 7px;border:1px solid #ccc;border-radius:3px;margin-bottom:6px;';
        constSection.appendChild(constInput);

        var constDatalist = document.createElement('datalist');
        constDatalist.id = 'postcardKnownConstellations';
        constSection.appendChild(constDatalist);
        self._populateKnownConstellations(constDatalist);

        var constMsg = document.createElement('div');
        constMsg.style.cssText = 'font-size:11px;color:#999;min-height:14px;margin-bottom:6px;';
        constSection.appendChild(constMsg);

        var constBtnRow = document.createElement('div');
        constBtnRow.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';
        var constCancelBtn = document.createElement('button');
        constCancelBtn.textContent = 'Cancel';
        constCancelBtn.style.cssText = 'font-size:11px;padding:4px 10px;cursor:pointer;border:1px solid #ccc;border-radius:3px;background:#fff;';
        constCancelBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._closeSendPanel();
        });
        constBtnRow.appendChild(constCancelBtn);

        var postBtn2 = document.createElement('button');
        postBtn2.textContent = 'Post';
        postBtn2.style.cssText = 'font-size:11px;padding:4px 10px;cursor:pointer;border:1px solid #E31361;border-radius:3px;background:#fde6ee;';
        function submitConstellation() {
          var name = constInput.value.trim();
          if (!name) { constMsg.textContent = 'Enter a constellation name'; constMsg.style.color = '#c33'; return; }
          if (!self._objId) { constMsg.textContent = 'Save first'; constMsg.style.color = '#c33'; return; }
          postBtn2.disabled = true;
          constMsg.textContent = 'Posting…';
          constMsg.style.color = '#888';
          self._doSendToConstellation(name, function (err) {
            postBtn2.disabled = false;
            if (err) { constMsg.textContent = err.message || 'Failed'; constMsg.style.color = '#c33'; return; }
            constMsg.textContent = 'Posted to ' + name;
            constMsg.style.color = '#2a2';
            setTimeout(function () { self._closeEditor(); }, 800);
          });
        }
        postBtn2.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          submitConstellation();
        });
        constBtnRow.appendChild(postBtn2);
        constSection.appendChild(constBtnRow);
        constInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') submitConstellation();
        });

        this._sendPanelTabs = { handle: handleTab, constellation: constTab };
        this._sendPanelSections = { handle: handleSection, constellation: constSection };
        this._sendPanelInputs = { handle: handleInput, constellation: constInput };
        this._selectSendTab(tab);
      },

      _selectSendTab: function (tab) {
        if (!this._sendPanelTabs) return;
        this._sendPanelTab = tab;
        var onHandle = tab === 'handle';
        this._sendPanelTabs.handle.style.color = onHandle ? '#333' : '#888';
        this._sendPanelTabs.handle.style.borderBottomColor = onHandle ? '#E31361' : 'transparent';
        this._sendPanelTabs.constellation.style.color = onHandle ? '#888' : '#333';
        this._sendPanelTabs.constellation.style.borderBottomColor = onHandle ? 'transparent' : '#E31361';
        this._sendPanelSections.handle.style.display = onHandle ? '' : 'none';
        this._sendPanelSections.constellation.style.display = onHandle ? 'none' : '';
        this._sendPanelInputs[tab].focus();
      },

      _closeSendPanel: function () {
        if (this._sendPanel) { this._sendPanel.remove(); this._sendPanel = null; }
        if (this._sendBackdrop) { this._sendBackdrop.remove(); this._sendBackdrop = null; }
        this._sendPendingTab = null;
        this._sendPanelTab = null;
        this._sendPanelTabs = null;
        this._sendPanelSections = null;
        this._sendPanelInputs = null;
      },

      // Unlike the panel it replaced, this one lives on document.body (not
      // shapeNode — see CLAUDE.md), so it isn't torn down for free when the
      // editor morph's own DOM goes away. Close it explicitly or it's left
      // floating after the editor closes.
      remove: function ($super) {
        this._closeSendPanel();
        $super();
      },

      // A successful send/post is treated as "done with this card" — close
      // the whole editor (window chrome included), not just the send panel.
      // getWindow() covers the normal windowed case (_openInCenteredWindow);
      // the plain remove() fallback covers a freestanding/embedded editor
      // that was never wrapped in one.
      _closeEditor: function () {
        this._closeSendPanel();
        var win = this.getWindow && this.getWindow();
        if (win && win.initiateShutdown) win.initiateShutdown();
        else this.remove();
      },

      // thenDo(err, result) — result is the inbox POST's JSON body
      // ({ok:true, delivered:true} or the POSTAL_REJECTION shape). Delivering
      // freezes the card server-side (state.sentAt): this is the permanent way to
      // hand someone a card, where the audience button is the editable one.
      _doSend: function (handle, thenDo) {
        var self = this;
        if (!this._objId) return thenDo(new Error('Save the card before sending'));

        lively.identity.webKey.resolveHandle(handle, function (err, info) {
          if (err || !info || !info.did) return thenDo(new Error('Handle not found: @' + handle));

          // Blocking disables interaction both ways — this covers "I've
          // blocked them" (the /inbox route's own sender-side check is the
          // server-side backstop for this same case; the recipient-blocked-
          // me case was already covered there before this feature).
          if (lively.identity.did.isBlocked(info.did, handle)) {
            return thenDo(new Error("You've blocked @" + handle + " — unblock them to send."));
          }

          if (self._visibility === 'public') {
            return self._postInbox(handle, thenDo);
          }

          // Private/shared: preflight-check the recipient can actually
          // receive encrypted content before doing a full autosave + reseal
          // of every existing recipient just to find out they can't. The
          // post-save check below stays as a safety net (their key could in
          // principle stop resolving between this check and the save).
          self._resolveRecipientPubKeys([handle], function (_e, preflight) {
            if (preflight.failed.length) {
              return thenDo(new Error("@" + handle + " hasn't set up encryption yet — cannot share with them."));
            }

            // Grant access — seal the card to them as well (on top of whatever
            // audience it has) and notify once that has landed.
            self._extraRecipientHandles = [handle];
            self._saveNow(function (saveErr) {
              self._extraRecipientHandles = [];
              if (saveErr) return thenDo(saveErr);
              // If the handle isn't among the people the stored version was sealed
              // to, their key couldn't be resolved and they were silently dropped
              // from record.recipients (see _resolveRecipientPubKeys) — don't
              // notify someone who was never actually granted access, or
              // they'd see the card in their inbox and hit a 403 opening it.
              if (self._lastSealedHandles.indexOf(handle) === -1) {
                return thenDo(new Error("@" + handle + " hasn't set up encryption yet — cannot share with them."));
              }
              // §6: sync each attachment's own transport ACL to the new
              // recipient too — non-fatal, see _grantAttachmentsAccess.
              self._grantAttachmentsAccess(handle, function () {
                self._postInbox(handle, thenDo);
              });
            });
          });
        });
      },

      _postInbox: function (handle, thenDo) {
        var base = lively.identity.did.baseUrl();
        var url = base + '/@' + encodeURIComponent(handle) + '/inbox';
        var xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true;
        xhr.onload = function () {
          var result;
          try { result = JSON.parse(xhr.responseText); } catch (e) { result = null; }
          if (xhr.status !== 200) {
            return thenDo(new Error('Send failed: ' + xhr.status));
          }
          thenDo(null, result);
        };
        xhr.onerror = function () { thenDo(new Error('Network error')); };
        xhr.send(JSON.stringify({ objId: this._objId }));
      },

    },

    // ─── embedded parts (§6, §10.8) ─────────────────────────────────────────────────
    // Insert-part toolbar button opens a picker over the user's own
    // identity-aware parts (lively.identity.IdentityPartsSpace) — never
    // classic WebDAV PartsBin. Embeds default to pinned (§6.2).

    'embeds', {

      _openPartsPicker: function () {
        if (this._partsPanel) { this._partsPanel.remove(); this._partsPanel = null; return; }
        var self = this;
        var shapeNode = this.renderContext().shapeNode;

        var panel = document.createElement('div');
        panel.style.cssText = [
          'position:absolute', 'top:40px', 'right:4px', 'width:240px',
          'background:#fff', 'border:1px solid #ccc', 'border-radius:6px',
          'box-shadow:0 4px 12px rgba(0,0,0,0.18)', 'padding:10px',
          'z-index:1000', 'box-sizing:border-box', 'font-family:sans-serif',
        ].join(';');

        var label = document.createElement('div');
        label.textContent = 'Insert part';
        label.style.cssText = 'font-size:12px;font-weight:600;margin-bottom:6px;color:#333;';
        panel.appendChild(label);

        var listDiv = document.createElement('div');
        listDiv.style.cssText = 'max-height:220px;overflow-y:auto;margin-bottom:6px;font-size:12px;color:#888;';
        listDiv.textContent = 'Loading…';
        panel.appendChild(listDiv);

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'font-size:11px;padding:4px 10px;cursor:pointer;border:1px solid #ccc;border-radius:3px;background:#fff;float:right;';
        cancelBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          panel.remove();
          self._partsPanel = null;
        });
        panel.appendChild(cancelBtn);

        ['keydown', 'keyup', 'keypress', 'mousedown', 'mousemove', 'mouseup', 'click'].forEach(function (t) {
          panel.addEventListener(t, function (e) { e.stopPropagation(); });
        });

        shapeNode.appendChild(panel);
        this._partsPanel = panel;

        if (typeof lively === 'undefined' || !lively.require) {
          listDiv.textContent = 'Lively module system not available';
          return;
        }
        lively.require('lively.identity.UserSpace').toRun(function () {
          lively.identity.userSpace.getPersonalPartsSpace(function (spaceErr, space) {
            if (spaceErr) { listDiv.textContent = 'Error: ' + spaceErr.message; return; }
            space.load(function (loadErr) {
              if (loadErr) { listDiv.textContent = 'Error: ' + loadErr.message; return; }
              var items = space.getPartItems();
              listDiv.textContent = '';
              if (!items.length) {
                listDiv.textContent = 'No parts yet — right-click a morph and choose "Save to My Parts" first.';
                return;
              }
              items.forEach(function (item) {
                var meta = item.loadedMetaInfo;
                var row = document.createElement('div');
                row.textContent = (meta && meta.partName) || item.name;
                if (meta && meta.comment) row.title = meta.comment;
                row.style.cssText = 'padding:4px 6px;cursor:pointer;border-radius:3px;color:#333;';
                row.addEventListener('mouseenter', function () { row.style.background = '#eef'; });
                row.addEventListener('mouseleave', function () { row.style.background = ''; });
                row.addEventListener('mousedown', function (e) {
                  e.preventDefault(); e.stopPropagation();
                  self._insertPartEmbed(item);
                  panel.remove();
                  self._partsPanel = null;
                });
                listDiv.appendChild(row);
              });
            });
          });
        });
      },

      // Inserts an embeddedPart node pinned to the part's current cid (§6.2
      // default). item is an IdentityPartItem with .envelope already loaded
      // (IdentityPartsSpace.load populates this synchronously from ObjectStore).
      _insertPartEmbed: function (item) {
        if (!this.editorView) return;
        var envelope = item.envelope;
        if (!envelope || !envelope.record) return;
        var view = this.editorView;
        var state = view.state;
        var nodeType = state.schema.nodes.embeddedPart;
        if (!nodeType) return;
        var user = lively.identity.did.currentUser();
        var node = nodeType.create({
          objId: envelope.objId,
          cid: envelope.record.cid,
          handle: user && user.handle,
          embedId: this._generateEmbedId(),
        });
        this._insertBlockAtom(node);
        view.focus();
      },

      // Inserts a block-level atom (display math, video, audio, embedded part) at the selection.
      // replaceSelectionWith alone gets two things wrong:
      //  1. with a node selected (the atom left selected by the previous insert) it replaces
      //     that node instead of adding beside it, and
      //  2. when the new atom is the last node there is no text position after it, so
      //     ProseMirror leaves the selection ON the atom -- which sets up (1) for the next insert.
      // So: a node selection inserts after the node, and an atom with no text block after it
      // gets an empty paragraph that takes the caret. Cost, measured in the wiki editor's Preview
      // (same renderer): that paragraph is 0px tall but its 16px bottom margin shows below the last
      // block; it is added only when no text block follows, so repeated inserts do not pile up paragraphs.
      _insertBlockAtom: function (node) {
        var view = this.editorView;
        var prosemirror = this._ProseMirror();
        if (!view || !prosemirror) return;
        var TextSelection = prosemirror.state.TextSelection;
        var state = view.state;
        var tr = state.tr;
        var selected = state.selection.node;
        var end = null;                       // where the new atom ends, when the caret is not already after it
        if (selected && !selected.isInline) {
          tr.insert(state.selection.to, node);
          end = state.selection.to + node.nodeSize;
        } else {
          tr.replaceSelectionWith(node);
          if (tr.selection.node) end = tr.selection.to;   // landed on the atom: nothing after it
        }
        if (end !== null) {
          var after = tr.doc.resolve(end).nodeAfter;
          if (!(after && after.isTextblock)) tr.insert(end, state.schema.nodes.paragraph.create());
          tr.setSelection(TextSelection.create(tr.doc, end + 1));
        }
        view.dispatch(tr.scrollIntoView());
      },

      _generateEmbedId: function () {
        return 'embed-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      },

      // NodeView for embeddedPart (§6, §10.8). Parts are Lively Morphs, and
      // this editor already runs inside a live Morphic world — so unlike
      // Wave's gadget iframes, a part can be deserialized and mounted
      // directly into the same DOM/JS realm, no cross-frame bridge needed.
      // `dom` (returned to ProseMirror) wraps a separate `contentDiv` so the
      // pinned/live overlay (appended to `dom`) survives contentDiv reloads.
      _embeddedPartNodeView: function (node, view, getPos) {
        var self = this;
        var destroyed = false;

        var dom = document.createElement('div');
        dom.className = 'lively-embedded-part-node';
        var contentDiv = document.createElement('div');
        contentDiv.className = 'lively-embedded-part-content';
        dom.appendChild(contentDiv);

        function showError(msg) {
          contentDiv.innerHTML = '';
          contentDiv.classList.add('lively-embed-error');
          contentDiv.textContent = msg;
        }

        function fetchAndRender(currentNode) {
          contentDiv.innerHTML = '';
          contentDiv.classList.remove('lively-embed-error');
          contentDiv.textContent = 'Loading part…';
          var handle = currentNode.attrs.handle;
          var objId = currentNode.attrs.objId;
          var cid = currentNode.attrs.cid;
          if (!handle || !objId) { showError('Embed missing objId/handle'); return; }
          var base = lively.identity.did.baseUrl();
          var url = base + '/@' + encodeURIComponent(handle) + '/' + encodeURIComponent(objId) +
            (cid ? ('/at/' + encodeURIComponent(cid)) : '');
          var xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          xhr.setRequestHeader('Accept', 'application/json');
          xhr.withCredentials = true;
          xhr.onload = function () {
            if (destroyed) return;
            if (xhr.status === 404) { showError(cid ? 'This part was removed.' : 'Part not found.'); return; }
            if (xhr.status !== 200) { showError('Failed to load part: HTTP ' + xhr.status); return; }
            var envelope;
            try { envelope = JSON.parse(xhr.responseText); } catch (e) { showError('Invalid part data'); return; }
            renderMorphFromEnvelope(envelope);
          };
          xhr.onerror = function () { if (!destroyed) showError('Network error loading part'); };
          xhr.send();
        }

        function renderMorphFromEnvelope(envelope) {
          if (typeof lively === 'undefined' || !lively.identity || !lively.identity.IdentityPartsSpace) {
            showError('Parts module not loaded'); return;
          }
          if (envelope.type !== 'part' || !envelope.record) { showError('Not a part envelope'); return; }
          var space = new lively.identity.IdentityPartsSpace(node.attrs.handle, null);
          var item = space.createPartItemFromEnvelope(envelope);
          if (!item) { showError('Missing partName in embedded object'); return; }
          item.loadPart(false, false, envelope.record.cid, function (err, part) {
            if (destroyed) return;
            if (err || !part) {
              showError('Could not render part: ' + ((err && err.message) || 'unknown error'));
              return;
            }
            contentDiv.innerHTML = '';
            var partDom = part.renderContext && part.renderContext().shapeNode;
            if (partDom) contentDiv.appendChild(partDom);
            else { showError('Part has no renderable content'); return; }
            // BUG FIX: a Lively morph's shapeNode is position:absolute, so it
            // never contributes to contentDiv's flow height — contentDiv (and
            // the outer .lively-embedded-part-node, which has overflow:hidden)
            // stayed at their near-zero/min-height:32px size regardless of the
            // morph's real extent, clipping everything below that to a thin
            // strip. Confirmed live: a 100x100 clock morph rendered as ~32px
            // of visible content. Sizing contentDiv explicitly to the part's
            // actual extent fixes it for any morph size.
            if (part.getExtent) {
              var partExtent = part.getExtent();
              contentDiv.style.width = partExtent.x + 'px';
              contentDiv.style.height = partExtent.y + 'px';
            }
            if (typeof part.onPostCardEmbed === 'function') {
              part.onPostCardEmbed(self._embedStateApi(node.attrs.embedId));
            }
          });
        }

        fetchAndRender(node);

        return {
          dom: dom,
          update: function (newNode) {
            if (newNode.type !== node.type) return false;
            var changed = newNode.attrs.cid !== node.attrs.cid || newNode.attrs.objId !== node.attrs.objId;
            node = newNode;
            if (changed) fetchAndRender(node);
            return true;
          },
          selectNode: function () { self._showEmbedOverlay(dom, node, view, getPos); },
          deselectNode: function () { self._hideEmbedOverlay(dom); },
          destroy: function () { destroyed = true; },
          ignoreMutation: function () { return true; },
        };
      },

      // NodeView for the persisted link_preview_card node (modeled on
      // _embeddedPartNodeView just above, not the click-to-edit
      // _mathNodeView — this node never has text to edit). Builds the card/
      // embed DOM once via the shared buildLinkPreviewCard (same builder the
      // read-only render's hydrateLinkPreviews and this node's own toDOM
      // fallback round-trip to) and only rebuilds it if url/embedUrl
      // actually changed, so an embed iframe doesn't reload on unrelated
      // doc edits elsewhere. Click-swallowing matches embeddedPart's own
      // convention (buildLinkPreviewCard's internal mousedown/click ->
      // stopPropagation listeners) rather than a NodeView-level stopEvent —
      // a cross-origin iframe's own internal clicks never bubble to the
      // parent document regardless, so there's nothing stopEvent would add.
      _linkPreviewCardNodeView: function (node, view, getPos) {
        var U = lively.identity.postCardUtils;
        var wrap = document.createElement('div');
        wrap.className = 'lively-link-preview-node';

        function render(currentNode) {
          wrap.innerHTML = '';
          wrap.appendChild(U.buildLinkPreviewCard(currentNode.attrs));
        }
        render(node);

        return {
          dom: wrap,
          update: function (newNode) {
            if (newNode.type !== node.type) return false;
            var changed = newNode.attrs.url !== node.attrs.url || newNode.attrs.embedUrl !== node.attrs.embedUrl;
            node = newNode;
            if (changed) render(node);
            return true;
          },
          selectNode: function () { wrap.classList.add('lively-link-preview-node-selected'); },
          deselectNode: function () { wrap.classList.remove('lively-link-preview-node-selected'); },
          ignoreMutation: function () { return true; },
        };
      },

      // NodeView for the image node (Encryption.md §6). Attachments uploaded
      // via FileCrypto never carry a real, permanently-fetchable src for a
      // private/shared postcard (its blob is encrypted) — this resolves the
      // node's objId to a decrypted, session-local blob: URL asynchronously
      // and swaps it into the DOM directly, WITHOUT ever touching
      // node.attrs/dispatching a transaction. That distinction matters: this
      // node is synced via y-prosemirror, so a dispatched change would push
      // a transient, per-browser blob: URL into the shared Y.Doc and even
      // persist it on next save — a bug, not a feature. A node with a real
      // src already (public attachment, or a pre-Phase-2 legacy one) just
      // renders it directly, same as plain toDOM.
      _attachmentImageNodeView: function (node, view, getPos) {
        var self = this;
        var destroyed = false;
        var img = document.createElement('img');
        img.className = 'lively-postcard-image';

        function render(currentNode) {
          img.alt = currentNode.attrs.alt || '';
          if (currentNode.attrs.title) img.title = currentNode.attrs.title;
          img.classList.remove('lively-attachment-loading', 'lively-attachment-error');

          if (currentNode.attrs.src) {
            img.src = currentNode.attrs.src;
            return;
          }
          if (!currentNode.attrs.objId) return; // nothing to show

          img.classList.add('lively-attachment-loading');
          var entry = (self._attachments || []).find(function (a) { return a.objId === currentNode.attrs.objId; });
          if (!entry) {
            img.classList.remove('lively-attachment-loading');
            img.classList.add('lively-attachment-error');
            img.alt = 'Attachment data unavailable';
            return;
          }
          lively.identity.fileCrypto.resolveAttachmentUrl(self._handle, entry, function (err, url) {
            if (destroyed) return;
            img.classList.remove('lively-attachment-loading');
            if (err) {
              img.classList.add('lively-attachment-error');
              img.alt = 'Failed to load attachment';
              console.error('[PostCardEditor] attachment image resolve failed:', err);
              return;
            }
            img.src = url;
          });
        }

        render(node);

        return {
          dom: img,
          update: function (newNode) {
            if (newNode.type !== node.type) return false;
            var changed = newNode.attrs.objId !== node.attrs.objId || newNode.attrs.src !== node.attrs.src;
            node = newNode;
            if (changed) render(node);
            return true;
          },
          destroy: function () { destroyed = true; },
          ignoreMutation: function () { return true; },
        };
      },

      // NodeView for the video node — same reasoning as _attachmentImageNodeView
      // above (private/shared attachments resolve to a session-local blob:
      // URL asynchronously, swapped into the DOM directly without ever
      // touching node.attrs/dispatching a transaction).
      _attachmentVideoNodeView: function (node, view, getPos) {
        var self = this;
        var destroyed = false;
        var video = document.createElement('video');
        video.className = 'lively-postcard-video';
        video.controls = true;
        video.preload = 'metadata';

        function render(currentNode) {
          if (currentNode.attrs.name) video.title = currentNode.attrs.name;
          video.classList.remove('lively-attachment-loading', 'lively-attachment-error');

          if (currentNode.attrs.src) {
            video.src = currentNode.attrs.src;
            return;
          }
          if (!currentNode.attrs.objId) return; // nothing to show

          video.classList.add('lively-attachment-loading');
          var entry = (self._attachments || []).find(function (a) { return a.objId === currentNode.attrs.objId; });
          if (!entry) {
            video.classList.remove('lively-attachment-loading');
            video.classList.add('lively-attachment-error');
            return;
          }
          lively.identity.fileCrypto.resolveAttachmentUrl(self._handle, entry, function (err, url) {
            if (destroyed) return;
            video.classList.remove('lively-attachment-loading');
            if (err) {
              video.classList.add('lively-attachment-error');
              console.error('[PostCardEditor] attachment video resolve failed:', err);
              return;
            }
            video.src = url;
          });
        }

        render(node);

        return {
          dom: video,
          update: function (newNode) {
            if (newNode.type !== node.type) return false;
            var changed = newNode.attrs.objId !== node.attrs.objId || newNode.attrs.src !== node.attrs.src;
            node = newNode;
            if (changed) render(node);
            return true;
          },
          destroy: function () { destroyed = true; },
          ignoreMutation: function () { return true; },
        };
      },

      // NodeView for the audio node — same reasoning as
      // _attachmentVideoNodeView above.
      _attachmentAudioNodeView: function (node, view, getPos) {
        var self = this;
        var destroyed = false;
        var audio = document.createElement('audio');
        audio.className = 'lively-postcard-audio';
        audio.controls = true;
        audio.preload = 'metadata';

        function render(currentNode) {
          if (currentNode.attrs.name) audio.title = currentNode.attrs.name;
          audio.classList.remove('lively-attachment-loading', 'lively-attachment-error');

          if (currentNode.attrs.src) {
            audio.src = currentNode.attrs.src;
            return;
          }
          if (!currentNode.attrs.objId) return; // nothing to show

          audio.classList.add('lively-attachment-loading');
          var entry = (self._attachments || []).find(function (a) { return a.objId === currentNode.attrs.objId; });
          if (!entry) {
            audio.classList.remove('lively-attachment-loading');
            audio.classList.add('lively-attachment-error');
            return;
          }
          lively.identity.fileCrypto.resolveAttachmentUrl(self._handle, entry, function (err, url) {
            if (destroyed) return;
            audio.classList.remove('lively-attachment-loading');
            if (err) {
              audio.classList.add('lively-attachment-error');
              console.error('[PostCardEditor] attachment audio resolve failed:', err);
              return;
            }
            audio.src = url;
          });
        }

        render(node);

        return {
          dom: audio,
          update: function (newNode) {
            if (newNode.type !== node.type) return false;
            var changed = newNode.attrs.objId !== node.attrs.objId || newNode.attrs.src !== node.attrs.src;
            node = newNode;
            if (changed) render(node);
            return true;
          },
          destroy: function () { destroyed = true; },
          ignoreMutation: function () { return true; },
        };
      },

      // Floating pinned/live toggle + remove button, shown while the embed
      // node is selected. Appended to the outer `dom` (not contentDiv) so a
      // content refetch never wipes it out from under an open overlay.
      _showEmbedOverlay: function (dom, node, view, getPos) {
        this._hideEmbedOverlay(dom);
        var self = this;
        var overlay = document.createElement('div');
        overlay.className = 'lively-embed-overlay';

        var toggleBtn = document.createElement('button');
        toggleBtn.textContent = node.attrs.cid ? '📌 Pinned' : '🔴 Live';
        toggleBtn.title = node.attrs.cid
          ? 'Pinned to a fixed version — click to make live (always shows latest)'
          : 'Live — always shows the latest version — click to pin to the current version';
        toggleBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._toggleEmbedPinning(node, view, getPos);
        });
        overlay.appendChild(toggleBtn);

        var removeBtn = document.createElement('button');
        removeBtn.textContent = '✕';
        removeBtn.title = 'Remove embed';
        removeBtn.className = 'lively-embed-remove-btn';
        removeBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          var pos = typeof getPos === 'function' ? getPos() : null;
          if (pos === null || pos === undefined) return;
          view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
          view.focus();
        });
        overlay.appendChild(removeBtn);

        dom.appendChild(overlay);
      },

      _hideEmbedOverlay: function (dom) {
        var existing = dom.querySelector && dom.querySelector('.lively-embed-overlay');
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      },

      // Flip pinned <-> live (§6.2). Going live just drops cid; going pinned
      // re-resolves the part's current cid first, then sets it.
      _toggleEmbedPinning: function (node, view, getPos) {
        var pos = typeof getPos === 'function' ? getPos() : null;
        if (pos === null || pos === undefined) return;
        if (node.attrs.cid) {
          view.dispatch(view.state.tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, { cid: null })));
          return;
        }
        var base = lively.identity.did.baseUrl();
        var url = base + '/@' + encodeURIComponent(node.attrs.handle) + '/' + encodeURIComponent(node.attrs.objId);
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) return;
          var envelope;
          try { envelope = JSON.parse(xhr.responseText); } catch (e) { return; }
          if (!envelope.record || !envelope.record.cid) return;
          view.dispatch(view.state.tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, { cid: envelope.record.cid })));
        };
        xhr.send();
      },

      // Per-embed shared state store, backed by one of two mechanisms
      // depending on mode (§1/§2.3, §10.8):
      //
      // Wiki mode (§1.2): a nested Y.Map at yDoc.getMap('partState').get(embedId).
      // Created lazily on first embed render; playback replays it for free
      // since it's part of the same Yjs update blob as the rest of the
      // document. Multiple writers can observe each other's changes live.
      //
      // Plain mode (§1.1/§2.3 — every card today): this._partState[embedId],
      // a plain JS object serialized as payload.partState on save (§2.3).
      // There is no cross-client push here — a plain card is single-author,
      // or entirely frozen once sent (§2.5) — so .observe is a same-tab,
      // synchronous notify only: it fires immediately after a local .set()
      // on this exact editor instance, never from any external source. A
      // .set() also schedules the normal debounced autosave (_markEdited)
      // since, unlike the wiki path, nothing else would persist this store —
      // it isn't part of any ProseMirror transaction Yjs or dispatchTransaction
      // would otherwise pick up.
      //
      // Both branches return the same { get, set, observe } shape so a part's
      // onPostCardEmbed(api) doesn't need to know which mode it's in.
      _embedStateApi: function (embedId) {
        if (!embedId) return null;

        if (this._isWikiMode) {
          var Y = this._Y();
          if (!Y || !this.yDoc) return null;
          var partStateMap = this.yDoc.getMap('partState');
          var embedMap = partStateMap.get(embedId);
          if (!(embedMap instanceof Y.Map)) {
            embedMap = new Y.Map();
            partStateMap.set(embedId, embedMap);
          }
          return {
            get: function (key) { return embedMap.get(key); },
            set: function (key, value) { embedMap.set(key, value); },
            observe: function (fn) {
              embedMap.observe(fn);
              return function () { embedMap.unobserve(fn); };
            },
          };
        }

        var self = this;
        if (!this._partState) this._partState = {};
        if (!this._partState[embedId]) this._partState[embedId] = {};
        var store = this._partState[embedId];
        var observers = [];
        return {
          get: function (key) { return store[key]; },
          set: function (key, value) {
            store[key] = value;
            self._markEdited();
            observers.forEach(function (fn) {
              try { fn({ key: key, value: value }); } catch (e) {}
            });
          },
          observe: function (fn) {
            observers.push(fn);
            return function () {
              var idx = observers.indexOf(fn);
              if (idx !== -1) observers.splice(idx, 1);
            };
          },
        };
      },

    },

    // ─── toolbar commands ─────────────────────────────────────────────────────────

    'toolbar', {

      _execToolbarCmd: function (btnDef) {
        if (!this.editorView) return;
        var view = this.editorView;
        var state = view.state;
        var dispatch = view.dispatch.bind(view);
        var prosemirror = this._ProseMirror();
        if (!prosemirror) return;

        switch (btnDef.cmd) {
          case 'toggleMark': {
            var markType = state.schema.marks[btnDef.markType];
            if (!markType) return;
            prosemirror.commands.toggleMark(markType)(state, dispatch);
            break;
          }
          case 'setBlockType': {
            var nodeType = state.schema.nodes[btnDef.nodeType];
            if (!nodeType) return;
            prosemirror.commands.setBlockType(nodeType, btnDef.attrs)(state, dispatch);
            break;
          }
          case 'wrapInList': {
            var listNodeType = state.schema.nodes[btnDef.nodeType];
            if (!listNodeType) return;
            if (prosemirror.schemaList && prosemirror.schemaList.wrapInList) {
              prosemirror.schemaList.wrapInList(listNodeType)(state, dispatch);
            }
            break;
          }
          case 'wrapIn': {
            var wrapNodeType = state.schema.nodes[btnDef.nodeType];
            if (!wrapNodeType) return;
            prosemirror.commands.wrapIn(wrapNodeType)(state, dispatch);
            break;
          }
          case 'insertMath': {
            var mathNodeType = btnDef.mathType === 'display'
              ? state.schema.nodes.math_display
              : state.schema.nodes.math_inline;
            if (!mathNodeType) return;
            var mathNode = mathNodeType.create({ value: '' });
            if (btnDef.mathType === 'display') this._insertBlockAtom(mathNode);
            else dispatch(state.tr.replaceSelectionWith(mathNode));
            break;
          }
          case 'setAlign':
          case 'setLineHeight': {
            // Block-level attrs: applied to every paragraph/heading the
            // selection touches (nodesBetween also descends into list items
            // and blockquotes), not just the cursor's own block.
            var blockAttr = btnDef.cmd === 'setAlign' ? 'align' : 'lineHeight';
            var blockValue = btnDef.cmd === 'setAlign' ? btnDef.align : btnDef.lineHeight;
            var blockTr = state.tr;
            state.doc.nodesBetween(state.selection.from, state.selection.to, function (node, pos) {
              if (!node.attrs || node.attrs[blockAttr] === undefined) return;
              var nextAttrs = Object.assign({}, node.attrs);
              nextAttrs[blockAttr] = blockValue;
              blockTr.setNodeMarkup(pos, null, nextAttrs);
            });
            if (blockTr.docChanged) dispatch(blockTr);
            break;
          }
          case 'setBlockStyle': {
            // Styles dropdown: 'p' = Normal text, '1'..'6' = heading level.
            // Keeps each block's align/lineHeight (setBlockType with fixed
            // attrs would reset them).
            var toHeading = btnDef.style !== 'p';
            var styleType = toHeading ? state.schema.nodes.heading : state.schema.nodes.paragraph;
            var styleTr = state.tr;
            state.doc.nodesBetween(state.selection.from, state.selection.to, function (node, pos) {
              if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return;
              // A list item's first child must stay a paragraph.
              var $sp = state.doc.resolve(pos);
              if (toHeading && $sp.parent.type.name === 'list_item' && $sp.index() === 0) return false;
              var styleAttrs = { align: node.attrs.align, lineHeight: node.attrs.lineHeight };
              if (toHeading) styleAttrs.level = parseInt(btnDef.style, 10);
              else if (node.attrs.indent !== undefined) styleAttrs.indent = node.attrs.indent;
              styleTr.setNodeMarkup(pos, styleType, styleAttrs);
              return false;
            });
            if (styleTr.docChanged) dispatch(styleTr);
            break;
          }
          case 'setList': {
            this._setList(btnDef.listType);
            break;
          }
          case 'indent':
          case 'outdent': {
            var $ip = state.selection.$from;
            var indentNode = $ip.parent;
            if (indentNode.attrs.indent === undefined) return;
            var delta = btnDef.cmd === 'indent' ? 1 : -1;
            var nextIndent = Math.max(0, Math.min(8, (indentNode.attrs.indent || 0) + delta));
            dispatch(state.tr.setNodeMarkup($ip.before($ip.depth), null,
              Object.assign({}, indentNode.attrs, { indent: nextIndent })));
            break;
          }
          case 'clearFormatting': {
            var clearTr = state.tr;
            var from = state.selection.from, to = state.selection.to;
            Object.keys(state.schema.marks).forEach(function (name) {
              clearTr = clearTr.removeMark(from, to, state.schema.marks[name]);
            });
            dispatch(clearTr);
            break;
          }
          case 'link': {
            this._promptLink();
            break;
          }
          case 'attachment': {
            this._promptAttachment();
            break;
          }
          case 'stamp': {
            this._promptStamp();
            return;
          }
          case 'backView': {
            this._showBackView(!this._backViewActive);
            return;
          }
          case 'preview': {
            this._togglePreview();
            return;
          }
          case 'insertPart': {
            if (this._openPartsPicker) this._openPartsPicker();
            else alert('Insert part — coming soon');
            break;
          }
        }
        view.focus();
      },

      // List dropdown commands. listType is bullet_list | ordered_list |
      // check_list | 'none'. Not in a list → wrap; in the same kind of list
      // → unwrap the whole list (a toggle); in a different kind → convert in
      // place (all three share list_item children, so only the list node's
      // own type changes).
      _setList: function (listType) {
        var view = this.editorView;
        var prosemirror = this._ProseMirror();
        var sl = prosemirror && prosemirror.schemaList;
        if (!view || !sl) return;
        var state = view.state;
        var schema = state.schema;
        var LIST_TYPES = ['bullet_list', 'ordered_list', 'check_list'];

        var $from = state.selection.$from;
        var listDepth = -1;
        for (var d = $from.depth; d > 0; d--) {
          if (LIST_TYPES.indexOf($from.node(d).type.name) >= 0) { listDepth = d; break; }
        }

        if (listDepth >= 0 && (listType === 'none' || $from.node(listDepth).type.name === listType)) {
          // Lift every item of the cursor's list, not just the cursor's own:
          // select across the whole list first, then lift. The selection-only
          // transaction leaves the doc object untouched, so the lift
          // transaction built from it still applies to the live view state.
          var TextSelection = prosemirror.state.TextSelection;
          var listStart = $from.start(listDepth), listEnd = $from.end(listDepth);
          var wholeList = state.apply(state.tr.setSelection(
            TextSelection.between(state.doc.resolve(listStart), state.doc.resolve(listEnd))));
          sl.liftListItem(schema.nodes.list_item)(wholeList, view.dispatch.bind(view));
        } else if (listDepth < 0) {
          if (listType !== 'none') sl.wrapInList(schema.nodes[listType])(state, view.dispatch.bind(view));
        } else {
          var listNode = $from.node(listDepth);
          var listPos = $from.before(listDepth);
          var tr = state.tr.setNodeMarkup(listPos, schema.nodes[listType],
            listType === 'ordered_list' ? { order: 1 } : null);
          // Leaving a checklist: drop the per-item checked state.
          if (listNode.type.name === 'check_list') {
            listNode.forEach(function (item, offset) {
              tr.setNodeMarkup(listPos + 1 + offset, null, Object.assign({}, item.attrs, { checked: null }));
            });
          }
          view.dispatch(tr);
        }
        view.focus();
      },

      // Toggles a read-only overlay over the editing area showing the card
      // exactly as PostCardView will render it (photo galleries, full-frame
      // video), so the author can check layout before saving/sending.
      _togglePreview: function () {
        if (this._previewEl) {
          if (this._previewEl.parentNode) this._previewEl.parentNode.removeChild(this._previewEl);
          this._previewEl = null;
          this._pmContainer.style.visibility = '';
          if (this._previewBtn) this._previewBtn.classList.remove('pce-active');
          if (this.editorView) this.editorView.focus();
          return;
        }
        if (!this.editorView) return;
        var utils = lively.identity.postCardUtils;
        var el = document.createElement('div');
        el.className = 'lively-postcard-preview selectable';
        el.style.cssText = [
          'position:absolute', 'top:64px', 'left:0', 'right:0', 'bottom:36px',
          'overflow-y:auto', 'padding:16px 20px', 'box-sizing:border-box',
          'font-family:sans-serif', 'font-size:' + this._DEFAULT_FONT_SIZE + 'px', 'line-height:1.6',
          'background:#fff', 'z-index:5',
        ].join(';');
        ['keydown', 'keyup', 'keypress', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick'].forEach(function (t) {
          el.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        el.innerHTML = utils.snapshotToHtml(this.editorView.state.doc.toJSON());
        this._pmContainer.parentNode.appendChild(el);
        this._pmContainer.style.visibility = 'hidden';
        this._previewEl = el;
        if (this._previewBtn) this._previewBtn.classList.add('pce-active');
        utils.hydrateEmbeddedParts(el);
        utils.hydrateAttachments(el, this._handle, this._attachments || []);
      },

      // Insert/edit/remove a link mark over the current selection.
      _promptLink: function () {
        if (!this.editorView) return;
        var view = this.editorView;
        var state = view.state;
        var linkType = state.schema.marks.link;
        if (!linkType) return;
        var from = state.selection.from, to = state.selection.to;
        if (from === to) return; // requires a text selection
        var existingHref = null;
        state.doc.nodesBetween(from, to, function (node) {
          if (existingHref) return false;
          var mark = linkType.isInSet(node.marks || []);
          if (mark) existingHref = mark.attrs.href;
        });
        var href = window.prompt(
          existingHref ? 'Edit link URL (blank to remove):' : 'Link URL:',
          existingHref || 'https://'
        );
        if (href === null) return; // cancelled
        href = href.trim();
        var tr = state.tr.removeMark(from, to, linkType);
        if (href) tr = tr.addMark(from, to, linkType.create({ href: href }));
        view.dispatch(tr);
        view.focus();
      },

      // Encrypt-and-upload a file via FileCrypto, then insert a reference to
      // it at the cursor (§10.1's insert-attachment; Encryption.md §6 for
      // the encrypted-attachment design).
      _promptAttachment: function () {
        var self = this;
        var input = document.createElement('input');
        input.type = 'file';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', function () {
          var file = input.files && input.files[0];
          if (input.parentNode) input.parentNode.removeChild(input);
          if (file) self._uploadAttachment(file);
        });
        input.click();
      },

      // Attachment visibility/recipients mirror the postcard's own (§6) —
      // resolved fresh at upload time so a just-added recipient (this
      // session, not yet saved) still gets sealed in.
      _uploadAttachment: function (file) {
        var self = this;
        if (!this._handle) return;
        var isImage = /^image\//.test(file.type || '');
        var isVideo = /^video\//.test(file.type || '');
        var isAudio = /^audio\//.test(file.type || '');

        this._uploadFileEntry(file, function (err, entry) {
          if (err) return;
          // Inserting the node/mark below dispatches a doc-changing
          // transaction, which dispatchTransaction already routes through
          // _markEdited/_scheduleSave — no separate save trigger needed.
          if (isImage) self._insertAttachmentImage(entry);
          else if (isVideo) self._insertAttachmentVideo(entry);
          else if (isAudio) self._insertAttachmentAudio(entry);
          else self._insertAttachmentLink(entry);
          self._setStatus('Uploaded');
        });
      },

      // Encrypt-and-upload core shared by inline attachments and back-of-card
      // stamps: uploads `file`, pushes the resulting entry onto _attachments,
      // and calls cb(err, entry). Does NOT insert it anywhere — the caller
      // decides what the entry is for.
      _uploadFileEntry: function (file, cb) {
        var self = this;
        if (!this._handle) return cb(new Error('No handle'));

        function withRecipients(cb) {
          if (self._visibility === 'public') return cb([]);
          self._ensureAudienceLoaded(function () {
            self._sealTargetHandles(function (targetErr, handles) {
              if (targetErr || !handles.length) return cb([]);
              self._resolveRecipientPubKeys(handles, function (_e, result) {
                cb(result.resolved.map(function (r) { return { did: r.did, x25519PublicKey: r.x25519PublicKey }; }));
              });
            });
          });
        }

        this._setStatus('Encrypting…');
        withRecipients(function (recipients) {
          lively.identity.fileCrypto.encryptAndUpload(file, {
            visibility: self._visibility,
            recipients: recipients,
            onWaiting: function () { self._setStatus('Confirm passkey…'); },
          }, function (err, result) {
            if (err) {
              self._setStatus('Upload failed');
              console.error('[PostCardEditor] attachment upload failed:', err);
              return cb(err);
            }
            var entry = {
              objId: result.objId,
              // dek travels inside the postcard's own encrypted payload
              // (§6) — base64url so it round-trips through JSON like every
              // other field there. null for a public card (blob already
              // plaintext, see FileCrypto.encryptAndUpload).
              dek: result.dek ? lively.identity.crypto.base64urlEncode(result.dek) : null,
              blobCid: result.blobCid,
              blobNonce: result.blobNonce,
              chunked: result.chunked,
              name: file.name,
              mime: file.type || 'application/octet-stream',
            };
            if (!self._attachments) self._attachments = [];
            self._attachments.push(entry);
            cb(null, entry);
          });
        });
      },

      // Image attachments render inline (§10.1) rather than as a text link.
      // A public attachment gets a real, permanently-fetchable src right
      // away (its blob is plaintext); a private/shared one gets an empty
      // src and relies on _attachmentImageNodeView to resolve+decrypt it
      // per-session (never baked into the synced doc — see that NodeView's
      // comment for why).
      _insertAttachmentImage: function (entry) {
        if (!this.editorView) return;
        var view = this.editorView;
        var state = view.state;
        var imageType = state.schema.nodes.image;
        if (!imageType) return;
        var src = entry.dek ? '' : this._publicBlobUrl(entry.blobCid);
        var node = imageType.create({ src: src, alt: entry.name, title: entry.name, objId: entry.objId });
        view.dispatch(state.tr.replaceSelectionWith(node));
        view.focus();
      },

      // Video attachments render inline (own block, per the image node's
      // comment above) rather than as a text link. Same public/private src
      // resolution as _insertAttachmentImage.
      // Block atoms go through _insertBlockAtom (see its note): a plain replaceSelectionWith
      // here could replace the previous atom instead of adding beside it.
      _insertAttachmentVideo: function (entry) {
        if (!this.editorView) return;
        var view = this.editorView;
        var state = view.state;
        var videoType = state.schema.nodes.video;
        if (!videoType) return;
        var src = entry.dek ? '' : this._publicBlobUrl(entry.blobCid);
        var node = videoType.create({ src: src, name: entry.name, objId: entry.objId });
        this._insertBlockAtom(node);
        view.focus();
      },

      // Audio attachments: same reasoning as _insertAttachmentVideo.
      _insertAttachmentAudio: function (entry) {
        if (!this.editorView) return;
        var view = this.editorView;
        var state = view.state;
        var audioType = state.schema.nodes.audio;
        if (!audioType) return;
        var src = entry.dek ? '' : this._publicBlobUrl(entry.blobCid);
        var node = audioType.create({ src: src, name: entry.name, objId: entry.objId });
        this._insertBlockAtom(node);
        view.focus();
      },

      // Non-image files: a plain link carrying the attachment's objId.
      // Public gets a real href (see _insertAttachmentImage); private/shared
      // gets no href — clicking is intercepted by the editor's
      // handleDOMEvents.click and resolved on demand (see _openAttachment).
      _insertAttachmentLink: function (entry) {
        if (!this.editorView) return;
        var view = this.editorView;
        var state = view.state;
        var linkType = state.schema.marks.link;
        var from = state.selection.from;
        var text = entry.name;
        var href = entry.dek ? '' : this._publicBlobUrl(entry.blobCid);
        var tr = state.tr.insertText(text, from);
        tr = tr.addMark(from, from + text.length, linkType.create({ href: href, title: entry.name, objId: entry.objId }));
        view.dispatch(tr);
        view.focus();
      },

      _publicBlobUrl: function (blobCid) {
        return lively.identity.did.baseUrl() + '/@' + encodeURIComponent(this._handle) + '/blobs/' + blobCid;
      },

      // Click handler target for a private/shared attachment link (§6):
      // resolve+decrypt via the dek embedded in the postcard's own payload,
      // then open it — no envelope round trip needed.
      _openAttachment: function (objId) {
        var self = this;
        var entry = (this._attachments || []).find(function (a) { return a.objId === objId; });
        if (!entry) return;
        this._setStatus('Decrypting…');
        lively.identity.fileCrypto.resolveAttachmentUrl(this._handle, entry, function (err, url) {
          if (err) {
            self._setStatus('Failed to open attachment');
            console.error('[PostCardEditor] attachment open failed:', err);
            return;
          }
          self._setStatus('');
          window.open(url, '_blank');
        });
      },

      // Sync each attachment's own file-envelope ACL to a newly-added
      // postcard recipient (§6) — non-fatal: the recipient already holds
      // every attachment's dek via the postcard payload itself once they can
      // decrypt the card, so a failed grant here only means a transient 403
      // on the blob route until the next save retries it (existing
      // grant-access route semantics; see IdentityServer.js).
      _grantAttachmentsAccess: function (recipientHandle, thenDo) {
        var attachments = this._attachments || [];
        var cb = thenDo || function () {};
        if (!attachments.length) return cb();
        var base = lively.identity.did.baseUrl();
        var remaining = attachments.length;
        attachments.forEach(function (a) {
          fetch(base + '/nodejs/IdentityServer/grant-access/' + encodeURIComponent(a.objId), {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipientHandle: recipientHandle }),
          }).catch(function (e) {
            console.warn('[PostCardEditor] grant-access failed for attachment', a.objId, '(non-fatal):', e.message);
          }).then(function () {
            if (--remaining === 0) cb();
          });
        });
      },

    },

    // ─── helpers ─────────────────────────────────────────────────────────────────

    'helpers', {

      _Y: function () {
        return (typeof Y !== 'undefined' && Y) ||
               (typeof window !== 'undefined' && window.Y) ||
               null;
      },

      _ProseMirror: function () {
        // ProseMirror modules are typically exposed under window.PM or
        // a bundle namespace. Check common patterns.
        if (typeof window === 'undefined') return null;
        if (window.PM) return window.PM;
        // If modules loaded individually, assemble them
        var model   = window.ProsemirrorModel;
        var state   = window.ProsemirrorState;
        var view    = window.ProsemirrorView;
        var commands = window.ProsemirrorCommands;
        var keymap  = window.ProsemirrorKeymap;
        var history = window.ProsemirrorHistory;
        if (!model || !state || !view) return null;
        return { model, state, view, commands: commands || {}, keymap: keymap || {}, history: history || {} };
      },

      _yProsemirror: function () {
        return (typeof yProsemirror !== 'undefined' && yProsemirror) ||
               (typeof window !== 'undefined' && window.yProsemirror) ||
               null;
      },

      _WebsocketProvider: function () {
        return (typeof WebsocketProvider !== 'undefined' && WebsocketProvider) ||
               (typeof window !== 'undefined' && window.WebsocketProvider) ||
               null;
      },

      // Builds the PostCard ProseMirror schema: prose nodes + math + embeddedPart.
      _buildSchema: function (modelModule) {
        return new modelModule.Schema({
          nodes: {
            doc:          { content: 'block+' },
            // align/indent (§10.1): presentation-only paragraph attrs, not
            // separate node types — matches the same "decoration, not schema
            // constraint" reasoning §10.5 uses for the title styling.
            paragraph:    { group: 'block', content: 'inline*',
                            attrs: { align: { default: 'left' }, indent: { default: 0 }, lineHeight: { default: null } },
                            parseDOM: [{ tag: 'p', getAttrs: _parseAlignIndent }],
                            toDOM: function(n) { return ['p', _alignIndentAttrs(n), 0]; } },
            heading:      { group: 'block', content: 'inline*',
                            attrs: { level: { default: 1 }, align: { default: 'left' }, lineHeight: { default: null } },
                            parseDOM: [1,2,3,4,5,6].map(function(l) {
                              return { tag: 'h'+l, getAttrs: function(d) {
                                var a = _parseAlignIndent(d); a.level = l; return a;
                              } };
                            }),
                            toDOM: function(n) {
                              var attrs = _alignIndentAttrs(n);
                              return ['h'+n.attrs.level, attrs, 0];
                            } },
            bullet_list:  { group: 'block', content: 'list_item+',
                            parseDOM: [{ tag: 'ul:not([data-type=checklist])' }], toDOM: function() { return ['ul', 0]; } },
            ordered_list: { group: 'block', content: 'list_item+', attrs: { order: { default: 1 } },
                            parseDOM: [{ tag: 'ol' }], toDOM: function() { return ['ol', 0]; } },
            // Checklist: same list_item children as the other lists (so the
            // Enter/Tab/Shift-Tab keymaps work unchanged); each item's own
            // `checked` attr carries its state, null reading as unchecked.
            check_list:   { group: 'block', content: 'list_item+',
                            parseDOM: [{ tag: 'ul[data-type=checklist]' }],
                            toDOM: function() { return ['ul', { 'data-type': 'checklist', class: 'lively-checklist' }, 0]; } },
            list_item:    { content: 'paragraph block*', attrs: { indent: { default: 0 }, checked: { default: null } },
                            parseDOM: [{ tag: 'li', getAttrs: _parseListItem }],
                            toDOM: function(n) { return ['li', _listItemAttrs(n), 0]; } },
            blockquote:   { group: 'block', content: 'block+',
                            parseDOM: [{ tag: 'blockquote' }], toDOM: function() { return ['blockquote', 0]; } },
            // class:'hljs' matches the bundled highlight.js theme's base
            // styling selector (background/text color) — the per-token
            // .hljs-keyword/.hljs-string/etc colors come from Decorations
            // (_buildHighlightPlugin), not from this node's own toDOM.
            code_block:   { group: 'block', content: 'text*', marks: '',
                            parseDOM: [{ tag: 'pre' }],
                            toDOM: function() { return ['pre', ['code', { class: 'hljs' }, 0]]; } },
            // Math nodes (§10.1): attrs.value holds the LaTeX source string.
            // atom:true keeps the cursor outside the node; editing is via the value attr.
            // Rendered by KaTeX via a custom NodeView (_mathNodeView) when live-edited;
            // toDOM below is the fallback used for parseDOM round-tripping only.
            math_inline:  { group: 'inline', inline: true, atom: true,
                            attrs: { value: { default: '' } },
                            parseDOM: [{ tag: 'code.math-inline', getAttrs: function(d) { return { value: d.textContent }; } }],
                            toDOM: function(n) { return ['code', { class: 'math-inline' }, n.attrs.value]; } },
            math_display: { group: 'block', atom: true,
                            attrs: { value: { default: '' } },
                            parseDOM: [{ tag: 'pre.math-display', getAttrs: function(d) { return { value: d.textContent }; } }],
                            toDOM: function(n) { return ['pre', { class: 'math-display' }, n.attrs.value]; } },
            // Embedded parts (§6.1): embedId used as key into ydoc.getMap('partState') (§10.8).
            embeddedPart: { group: 'block', atom: true,
                            attrs: { objId: { default: null }, cid: { default: null },
                                     handle: { default: null }, embedId: { default: null } },
                            parseDOM: [{ tag: 'div.lively-embedded-part', getAttrs: function(d) {
                              return { objId: d.getAttribute('data-obj-id'),
                                       cid:   d.getAttribute('data-cid'),
                                       handle: d.getAttribute('data-handle'),
                                       embedId: d.getAttribute('data-embed-id') };
                            }}],
                            toDOM: function(n) {
                              return ['div', { class: 'lively-embedded-part',
                                'data-obj-id': n.attrs.objId || '',
                                'data-cid':    n.attrs.cid    || '',
                                'data-handle': n.attrs.handle || '',
                                'data-embed-id': n.attrs.embedId || '' }];
                            } },
            // Persisted link-preview card: unlike the old purely-derived
            // decoration (still used while actively typing a URL — see
            // _buildLinkPreviewPlugin), this is a REAL node once inserted,
            // so it survives deleting the url text that produced it, both
            // live and across save/reload. embedUrl/provider set only for a
            // recognized Spotify/YouTube/SoundCloud/Apple Music link (see
            // LinkPreviewServer.js's detectEmbed) — toDOM branches to a
            // sandboxed <iframe> variant for those, matching
            // buildLinkPreviewCard/pmNodeToHtml's 'link_preview_card' case
            // in PostCardUtils.js exactly (div, not a, wrapping the iframe —
            // HTML forbids interactive content inside <a>).
            link_preview_card: { group: 'block', atom: true,
                            attrs: { url: { default: '' }, title: { default: null },
                                     description: { default: null }, image: { default: null },
                                     siteName: { default: null }, provider: { default: null },
                                     embedUrl: { default: null }, bluesky: { default: null } },
                            // Two tag matchers: toDOM emits a div for the embed
                            // variant, an a for the static card AND the Bluesky
                            // card (HTML forbids an iframe inside an a, but a
                            // Bluesky card has no iframe so it's fine as an a) —
                            // parseDOM needs both or a same-editor copy/paste of
                            // a static/Bluesky card (which round-trips through
                            // the DOM clipboard) would lose its node-ness and
                            // degrade to a plain link.
                            parseDOM: [{ tag: 'div.lively-link-preview-card', getAttrs: _getLinkPreviewCardAttrs },
                                       { tag: 'a.lively-link-preview-card', getAttrs: _getLinkPreviewCardAttrs }],
                            toDOM: function(n) {
                              var a = n.attrs;
                              var dataAttrs = { 'data-url': a.url || '', 'data-title': a.title || '',
                                'data-description': a.description || '', 'data-image': a.image || '',
                                'data-site-name': a.siteName || '', 'data-provider': a.provider || '',
                                'data-embed-url': a.embedUrl || '',
                                'data-bluesky': a.bluesky ? JSON.stringify(a.bluesky) : '' };
                              if (a.embedUrl) {
                                return ['div', Object.assign({ class: 'lively-link-preview-card lively-link-preview-embed' }, dataAttrs)];
                              }
                              var cls = a.bluesky ? 'lively-link-preview-card lively-link-preview-bluesky' : 'lively-link-preview-card';
                              return ['a', Object.assign({ class: cls, href: a.url || '',
                                target: '_blank', rel: 'noopener noreferrer' }, dataAttrs)];
                            } },
            // Inline image attachments (§10.1's insert-attachment, image case —
            // non-image files fall back to a plain link, see _insertAttachmentLink).
            // objId (Encryption.md §6): set for attachments uploaded via
            // FileCrypto; src is empty for a private/shared one (the actual
            // URL is resolved async, per-session, by the image NodeView —
            // see _attachmentImageNodeView) and a real, permanently-fetchable
            // blob URL for a public one or a pre-Phase-2 legacy attachment
            // (both render via plain toDOM/parseDOM with no NodeView
            // involvement needed, e.g. in postCardUtils.snapshotToHtml).
            image:        { group: 'inline', inline: true, atom: true,
                            attrs: { src: { default: '' }, alt: { default: '' }, title: { default: null },
                                     objId: { default: null } },
                            parseDOM: [{ tag: 'img[src]', getAttrs: function(d) {
                              return { src: d.getAttribute('src'), alt: d.getAttribute('alt') || '',
                                       title: d.getAttribute('title'), objId: d.getAttribute('data-obj-id') || null };
                            }}],
                            toDOM: function(n) {
                              return ['img', { src: n.attrs.src, alt: n.attrs.alt, title: n.attrs.title,
                                'data-obj-id': n.attrs.objId || '', 'class': 'lively-postcard-image' }];
                            } },
            // Video attachments (same objId/src convention as image above,
            // per-session blob-URL resolution for private/shared handled by
            // _attachmentVideoNodeView). Block-level, not inline — a native
            // <video controls> player doesn't want to flow inline with text.
            video:        { group: 'block', atom: true,
                            attrs: { src: { default: '' }, name: { default: '' }, objId: { default: null } },
                            parseDOM: [{ tag: 'video[src]', getAttrs: function(d) {
                              return { src: d.getAttribute('src'), name: d.getAttribute('data-name') || '',
                                       objId: d.getAttribute('data-obj-id') || null };
                            }}],
                            toDOM: function(n) {
                              return ['video', { src: n.attrs.src, controls: 'true', preload: 'metadata',
                                'data-name': n.attrs.name || '', 'data-obj-id': n.attrs.objId || '',
                                'class': 'lively-postcard-video' }];
                            } },
            audio:        { group: 'block', atom: true,
                            attrs: { src: { default: '' }, name: { default: '' }, objId: { default: null } },
                            parseDOM: [{ tag: 'audio[src]', getAttrs: function(d) {
                              return { src: d.getAttribute('src'), name: d.getAttribute('data-name') || '',
                                       objId: d.getAttribute('data-obj-id') || null };
                            }}],
                            toDOM: function(n) {
                              return ['audio', { src: n.attrs.src, controls: 'true', preload: 'metadata',
                                'data-name': n.attrs.name || '', 'data-obj-id': n.attrs.objId || '',
                                'class': 'lively-postcard-audio' }];
                            } },
            text:         { group: 'inline' },
            hard_break:   { group: 'inline', inline: true, selectable: false,
                            parseDOM: [{ tag: 'br' }], toDOM: function() { return ['br']; } },
          },
          marks: {
            bold:      { parseDOM: [{ tag: 'strong' }, { tag: 'b' }], toDOM: function() { return ['strong', 0]; } },
            italic:    { parseDOM: [{ tag: 'em' }, { tag: 'i' }],     toDOM: function() { return ['em', 0]; } },
            code:      { parseDOM: [{ tag: 'code' }],                  toDOM: function() { return ['code', 0]; } },
            underline:   { parseDOM: [{ tag: 'u' }], toDOM: function() { return ['u', 0]; } },
            strike:      { parseDOM: [{ tag: 's' }, { tag: 'strike' }, { tag: 'del' }], toDOM: function() { return ['s', 0]; } },
            superscript: { excludes: 'subscript', parseDOM: [{ tag: 'sup' }], toDOM: function() { return ['sup', 0]; } },
            subscript:   { excludes: 'superscript', parseDOM: [{ tag: 'sub' }], toDOM: function() { return ['sub', 0]; } },
            textColor:       { attrs: { color: {} },
                               parseDOM: [{ style: 'color', getAttrs: function(v) { return { color: v }; } }],
                               toDOM: function(m) { return ['span', { style: 'color:' + m.attrs.color }, 0]; } },
            backgroundColor: { attrs: { color: {} },
                               parseDOM: [{ style: 'background-color', getAttrs: function(v) { return { color: v }; } }],
                               toDOM: function(m) { return ['span', { style: 'background-color:' + m.attrs.color }, 0]; } },
            fontFamily: { attrs: { family: {} },
                          parseDOM: [{ style: 'font-family', getAttrs: function(v) { return { family: v }; } }],
                          toDOM: function(m) { return ['span', { style: 'font-family:' + m.attrs.family }, 0]; } },
            fontSize:   { attrs: { size: {} },
                          parseDOM: [{ style: 'font-size', getAttrs: function(v) { return { size: v }; } }],
                          toDOM: function(m) { return ['span', { style: 'font-size:' + m.attrs.size }, 0]; } },
            // objId (Encryption.md §6): set for a non-image attachment link
            // (uploaded via FileCrypto). A private/shared one has no usable
            // href (its blob is encrypted) — clicking it is intercepted by
            // the editor's handleDOMEvents.click, which resolves+decrypts on
            // demand (see _openAttachment). A public one gets a real,
            // permanently-fetchable href directly, same reasoning as the
            // image node above.
            // inclusive:false — text typed at the end of a link is plain text,
            // not more of the link (otherwise the space after a link is
            // swallowed into it and renders as an underlined run).
            link:   { attrs: { href: { default: '' }, title: { default: null }, objId: { default: null } },
                      inclusive: false,
                      parseDOM: [{ tag: 'a[href]', getAttrs: function(d) {
                        return { href: d.getAttribute('href'), title: d.getAttribute('title'),
                                 objId: d.getAttribute('data-attachment-obj-id') || null };
                      } }],
                      toDOM: function(m) {
                        var href = m.attrs.href || '';
                        var scheme = /^([a-z][a-z0-9+.\-]*):/i.exec(href);
                        var safeHref = (!scheme || scheme[1].toLowerCase() === 'http' || scheme[1].toLowerCase() === 'https' || scheme[1].toLowerCase() === 'mailto') ? href : '#';
                        var attrs = { href: safeHref || '#', title: m.attrs.title, rel: 'noopener noreferrer' };
                        if (m.attrs.objId) attrs['data-attachment-obj-id'] = m.attrs.objId;
                        return ['a', attrs, 0];
                      } },
          },
        });
      },

      _setStatus: function (msg) {
        console.log('[PostCardEditor] status:', msg);
        if (this._statusEl) this._statusEl.textContent = msg;
        if (this._statusLabel) this._statusLabel.textString = msg;
      },

      _showError: function (msg) {
        console.error('[PostCardEditor]', msg);
        this._setStatus('Error');
      },

    });

    // ─── window chrome accent ────────────────────────────────────────────────────
    // Module-scope (not a class method) — same placement/idiom as
    // PostCardMailbox.js's own _ensureAccentChromeCss/DMChat.js's
    // applyAccentChrome: a scoped, idempotency-guarded <style> injection plus
    // win.addStyleClassName(...), recolors the classic Window's title bar via
    // its own background (base_theme.css leaves `.Window .TitleBar` itself
    // transparent so the Window's fill shows through as the "mat frame").
    // Reuses this file's own established pink (#E31361/#fde6ee, already on
    // the Save/Send pills above) so the whole editor — chrome plus toolbar —
    // reads as one consistent accent, not two competing colors.
    function _ensureAccentChromeCss() {
      var STYLE_ID = 'postcard-editor-accent-chrome-style';
      if (document.getElementById(STYLE_ID)) return;
      var styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.textContent = [
        '.Window.pce-accent-chrome { background-color: #E31361 !important; border-radius: 12px !important; }',
        '.Window.pce-accent-chrome .Text.window-title { color: #fff; }',
        '.Window.pce-accent-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }',
        '.Window.pce-accent-chrome.highlighted { border: none !important; box-shadow: 0px 3px 10px rgba(120,10,50,0.35) !important; }',
      ].join('\n');
      document.head.appendChild(styleEl);
    }

    // ─── class-side entry points ─────────────────────────────────────────────────
    // Object.extend adds these as class methods (not instance methods).
    // 'class-side' is not a magic keyword in Lively's Object.subclass —
    // it would have added these as instance methods, shadowing Object.create.

    Object.extend(PostCardEditorClass, {

      // Wraps a freshly-created, freestanding editor in a lively.morphic.Window
      // (title bar drag handle, close (X) and minimize (–) controls) and
      // centers it — the standard Lively pattern for windowed content morphs
      // (see Widgets.js's own "Boxes inside a window cannot be dragged by just
      // clicking and moving" comment). _setup() separately disables the
      // editor's own body-dragging so text-selection drags don't move the
      // window instead.
      _openInCenteredWindow: function (editor, title) {
        var win = editor.openInWindow({ title: title });
        if (win) {
          _ensureAccentChromeCss();
          win.addStyleClassName('pce-accent-chrome');
          win.align(win.bounds().center(), lively.morphic.World.current().visibleBounds().center());
          win.bringToFront();
        }
      },

      // Load an existing postcard and open the editor.
      openCard: function (handle, objId, options) {
        var opts = options || {};
        var editor = new lively.identity.PostCardEditor(opts.bounds || lively.rect(0, 0, 785, 520));
        editor._handle = handle;
        editor._objId = objId;
        editor._isNew = false;
        if (opts.target) {
          opts.target.addMorph(editor);
          editor._setup();
        } else {
          this._openInCenteredWindow(editor, 'Post Card');
          editor._setup();
        }
        return editor;
      },

      // Create a new genesis postcard (objId not yet known) and open the editor.
      // opts.recipientHandle/opts.visibility (recipient presets, e.g. from
      // the profile card's postcard button): applied *after* _setup(), since _setup() itself
      // resets _visibility/_recipientHandles to their new-card defaults —
      // setting them beforehand would just get overwritten.
      //
      // opts.game / opts.text / opts.audience: a card started from another feature (the
      // Gaming template's "Share as postcard"). game is the block to attach, text the
      // opening words (a string, or an array of strings for several paragraphs), audience { tiers, people } who may read it. None of these saves
      // anything: the author reviews the card and it is created by their first edit or
      // Save. Applied once the editor exists, see _applyPrefill.
      newCard: function (handle, options) {
        var opts = options || {};
        var editor = new lively.identity.PostCardEditor(lively.rect(0, 0, 785, 520));
        editor._handle = handle;
        editor._objId = null;
        editor._isNew = true;
        editor._constellation = opts.constellation || null;
        if (opts.game || opts.text || opts.audience) {
          editor._pendingPrefill = { game: opts.game || null, text: opts.text || '', audience: opts.audience || null };
        }
        if (opts.target) {
          opts.target.addMorph(editor);
          editor._setup();
        } else {
          this._openInCenteredWindow(editor, 'New Post Card');
          editor._setup();
        }
        if (opts.recipientHandle) {
          editor._visibility = opts.visibility || 'private';
          editor._recipientHandles = [opts.recipientHandle];
          editor._presetRecipient = opts.recipientHandle;
          editor._updateVisibilityBtn();
        }
        return editor;
      },

    });

  }); // end module('lively.identity.PostCardEditor')
