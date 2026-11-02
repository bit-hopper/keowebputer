/**
 * lively.identity.WikiEditor
 *
 * BuildSpec morph — a windowed morph that embeds a ProseMirror EditorView
 * bound to a Y.Doc via ySyncPlugin, for constellation wiki pages
 * specifically. Split out of lively.identity.PostCardEditor when wiki pages
 * became their own envelope type (type: 'wikipage') instead of a
 * type:'postcard' + state.wikiName combination — PostCardEditor keeps only
 * the plain (single-author, no Yjs) editing path; this file keeps exactly
 * the live-multi-writer machinery wiki pages actually need. Toolbar, schema,
 * and NodeViews (math/embedded-part/image) are ported near-verbatim — they
 * were always generic, never postcard-specific — while save/load/sync logic
 * is wiki-only throughout (no plain-mode branch to speak of, since a
 * WikiEditor instance is never anything else).
 *
 * Deliberately NOT ported from PostCardEditor (postcard-only features that
 * never applied to wiki pages): reactions, hashtags, location
 * tags, mute/block, forwarding aliases, sent/immutability freeze, the
 * mailbox-hide delete mechanism, the visibility toggle (a wiki page's
 * readability is its constellation's canRead check, not its own — see
 * WikiSerializer.js's header), Send/inbox delivery, and "post to
 * constellation" (a wiki page is tied to its constellation at creation,
 * never posted into one after the fact).
 *
 * Architecture:
 *   - Extends lively.morphic.Box (windowed morph).
 *   - ProseMirror EditorView appended to renderContext().shapeNode (DOM).
 *   - ySyncPlugin + yUndoPlugin bind EditorView <-> Y.Doc.getXmlFragment('prosemirror').
 *   - WebsocketProvider (y-websocket) attaches to LiveDocSyncServer at
 *     /livedoc-sync/<objId> on the same origin/port as the page itself
 *     (LiveDocSyncServer.js rides the shared WS listener, no separate
 *     port), using the wiki page's objId as room name.
 *   - Auto-save: debounced 2s after the last change, serializes to a
 *     WikiSerializer envelope and PUTs /@:handle/:objId.
 *
 * CRITICAL: Y.Doc MUST be created with gc: false before passing to
 * WikiSerializer or attaching a WebsocketProvider. This file enforces that
 * at create-time.
 *
 * Entry points:
 *   lively.identity.WikiEditor.openCard(handle, objId)
 *     — loads an existing wiki page and opens the editor
 *   lively.identity.WikiEditor.newCard(handle, { constellation, wikiName })
 *     — creates a new genesis wiki page and opens the editor
 *
 * doNotSerialize list:
 *   editorView, yDoc, wsProvider
 *
 * Dependencies (must be loaded as plain scripts before first use):
 *   /lib/yjs/yjs.js, /lib/prosemirror/*, /lib/y-prosemirror/*, /lib/y-websocket/
 *
 * Dependencies (Lively modules, loaded via .requires):
 *   lively.identity.WikiSerializer
 *   lively.identity.DID
 */

module('lively.identity.WikiEditor')
  .requires(
    'lively.identity.WikiSerializer',
    'lively.identity.WikiPolicy',
    'lively.identity.DID',
    'lively.identity.WebAuthn',
    'lively.identity.WebKey',
    'lively.identity.FileCrypto',
    'lively.identity.SchemeEditing',
    'lively.identity.PostCardUtils',
  )
  .toRun(function () {

    // Shared by paragraph/heading/list_item toDOM/parseDOM (align/indent) —
    // module-scope so schema node specs can reference them without a `this`.
    var ALLOWED_ALIGN = { left: 1, center: 1, right: 1, justify: 1 };
    function _parseAlignIndent(dom) {
      var align = dom.style && dom.style.textAlign;
      var indent = dom.style && parseInt(dom.style.marginLeft, 10);
      return {
        align: ALLOWED_ALIGN[align] ? align : 'left',
        indent: (indent > 0) ? Math.round(indent / 24) : 0,
      };
    }
    function _alignIndentAttrs(node) {
      var style = '';
      if (node.attrs.align && node.attrs.align !== 'left') style += 'text-align:' + node.attrs.align + ';';
      if (node.attrs.indent) style += 'margin-left:' + (node.attrs.indent * 24) + 'px;';
      return style ? { style: style } : {};
    }

    // Shared by link_preview_card's two parseDOM tag matchers — see
    // PostCardEditor.js's identical copy for the full rationale (toDOM
    // emits a div for the embed variant, an a for the static card).
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

    var WikiEditorClass = lively.morphic.Box.subclass('lively.identity.WikiEditor',

    // ─── serialization guard ──────────────────────────────────────────────────────

    'serialization', {
      doNotSerialize: ['editorView', 'yDoc', 'wsProvider', '_saveTimer', '_pmContainer', '_contentLoadStarted', '_onSaved',
        '_previewContainer', '_previewMode', '_activeDropdown', '_outsideClickHandler',
        '_flowEl', '_heightObserver', '_onHeightChanged',
        '_editAccess', '_tokenTimer', '_permissionsRow', '_permPanel', '_permCloseHandler',
        '_saveInFlight', '_saveRerun', '_saveWaiters', '_restore'],
    },

    // ─── initialization ──────────────────────────────────────────────────────────

    'initialization', {

      _setup: function () {
        // Whether embedded via opts.target or standalone-in-world (see
        // openCard/newCard), this morph is never meant to be whole-body
        // draggable — without this, Lively's default whole-body dragging
        // intercepts mousedown on pmDiv before native text-selection drag
        // ever gets a chance.
        this.disableDragging();
        this.disableGrabbing();
        this._envelope = null;
        this.editorView = null;
        this.yDoc = null;
        this.wsProvider = null;
        this._saveTimer = null;
        this._pmContainer = null;
        this._previewContainer = null;
        this._previewMode = false;
        this._activeDropdown = null;
        this._outsideClickHandler = null;
        this._statusLabel = null;
        this._statusEl = null;
        this._toolbarDiv = null;
        // Attachment metadata: { objId, dek, blobCid, blobNonce, name, mime }
        // entries — pass-through inside the wiki page payload, hydrated from
        // the loaded envelope in _loadExistingNow.
        this._attachments = [];
        // True for a new page (you're creating it) or once _loadExistingNow
        // compares envelope.did to the session DID. envelope.did is fixed at
        // genesis (WikiSerializer.js) — it identifies the original author,
        // not "who's editing now."
        this._isOwner = true;
        // Whether THIS session may edit/save this page at all. Equals
        // _isOwner for a new/not-yet-loaded page. For a loaded page, a
        // non-owner may still have write access via constellation
        // membership — _loadExistingNow resolves that asynchronously (one
        // GET .../space-token round trip) before finalizing this flag.
        this._canEdit = true;
        // Set by WikiEditor.openCard's forceReadOnly option — used only by
        // WikiView, which embeds a target-mode editor purely to render
        // content and must never let that embed become editable/autosaving.
        // Preserved (not reset to false) across a restore-triggered re-run
        // of _setup().
        this._forceReadOnly = !!this._forceReadOnly;
        // _constellation/_wikiName are set by newCard's opts or
        // _loadExistingNow (from the loaded envelope) and are fixed for the
        // lifetime of this objId — a wiki page's constellation/name never
        // change after creation. _category/_tags are also set from opts or
        // the loaded envelope, but ARE user-editable metadata (unlike
        // _constellation/_wikiName) — see _saveNow, which must re-send
        // them on every autosave or serializeToEnvelope's stateMeta merge
        // (which replaces envelope.state wholesale, not a deep merge with
        // prevEnvelope.state) would silently wipe them on the next save.
        this._constellation = this._constellation || null;
        this._wikiName = this._wikiName || null;
        this._category = this._category || null;
        this._tags = this._tags || [];
        // Who may edit this page (constellation pages only): { mode, handles? }
        // as stored at state.editPolicy, or null = all members. Re-sent on
        // every save like category/tags (see _saveNow). The server's
        // GET .../edit-token answer -- canEdit, why not, the sync-room token --
        // is cached in _editAccess (see _fetchEditAccess).
        this._editPolicy = this._editPolicy || null;
        this._editAccess = null;
        this._readOnlyReason = null;
        this._buildChrome();

        // Guards against double-firing the async content-load dispatch
        // below — see PostCardEditor.js's identical guard for the full
        // race explanation (openCard/newCard's explicit _setup() call vs.
        // prepareForNewRenderContext's own call when this morph is added
        // to its window).
        if (this._contentLoadStarted) return;
        this._contentLoadStarted = true;
        if (this._isNew) {
          this._createNewDoc();
        } else {
          this._loadExisting();
        }
      },

      prepareForNewRenderContext: function ($super, renderCtx) {
        $super(renderCtx);
        if (!this._handle) return;
        this._setup();
      },

    },

    // ─── chrome (UI scaffolding) ─────────────────────────────────────────────────

    'chrome', {

      _buildChrome: function () {
        var self = this;
        this.setFill(Color.white);

        var shapeNode = this.renderContext().shapeNode;
        shapeNode.innerHTML = ''; // idempotent: safe if _setup() ever runs twice on one instance
        shapeNode.style.borderRadius = '8px';
        shapeNode.style.boxShadow = '0 4px 12px rgba(0,0,0,0.18)';

        var toolbarDiv = document.createElement('div');
        toolbarDiv.style.cssText = [
          'position:absolute', 'top:0', 'left:0', 'right:0', 'height:40px',
          'background:#f0f0f5', 'border-bottom:1px solid #ccc', 'box-sizing:border-box',
          'overflow:hidden',
        ].join(';');
        shapeNode.appendChild(toolbarDiv);
        this._toolbarDiv = toolbarDiv;
        this._buildToolbar(toolbarDiv);
        // A new page's author is known now; an existing page's is only known
        // once it has loaded (see _loadExistingNow's finishLoad).
        if (this._isNew) this._refreshPermissionsRow();

        // No footer: History/Save/status live in the toolbar (see
        // _buildSaveControls), so they stay reachable on a long page.
        this._footerDiv = null;

        this._buildLinkPreview(shapeNode);

        var pmDiv = document.createElement('div');
        pmDiv.className = 'lively-postcard-editor-container lively-wiki-editor-container selectable';
        pmDiv.style.cssText = [
          'position:absolute', 'top:40px', 'left:0', 'right:0', 'bottom:0',
          'overflow-y:auto', 'padding:16px 20px', 'box-sizing:border-box',
          'font-family:sans-serif', 'font-size:14px', 'line-height:1.6', 'white-space:pre-wrap',
        ].join(';');
        shapeNode.appendChild(pmDiv);
        this._pmContainer = pmDiv;

        // Preview mode's read-only render target -- a sibling of pmDiv,
        // hidden until _togglePreview shows it. Reuses WikiView's own
        // content class so the rendered HTML looks identical to how the
        // page will actually appear once published.
        var previewDiv = document.createElement('div');
        previewDiv.className = 'lively-wiki-view-content selectable';
        previewDiv.style.cssText = [
          'position:absolute', 'top:40px', 'left:0', 'right:0', 'bottom:0',
          'overflow-y:auto', 'padding:16px 20px', 'box-sizing:border-box', 'display:none',
        ].join(';');
        shapeNode.appendChild(previewDiv);
        this._previewContainer = previewDiv;

        // Shared stylesheet with PostCardEditor.js — same class names, same
        // rendering rules (math/embed/image), so it's fine for both editors
        // to insert the same singleton <style> tag idempotently.
        if (!document.getElementById('lively-postcard-editor-style')) {
          var styleEl = document.createElement('style');
          styleEl.id = 'lively-postcard-editor-style';
          styleEl.textContent =
            '.lively-postcard-editor-container .ProseMirror > :first-child {' +
            '  font-size:20px;font-weight:bold;margin-bottom:8px;' +
            '}' +
            '.lively-postcard-image{max-width:100%;max-height:320px;vertical-align:middle;' +
            'border-radius:4px;}' +
            '.lively-postcard-video{max-width:100%;max-height:400px;display:block;border-radius:4px;}' +
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
            '.lively-link-preview-node{margin:4px 0;border-radius:8px;}' +
            '.lively-link-preview-node.lively-link-preview-node-selected,' +
            '.lively-link-preview-node.ProseMirror-selectednode{outline:2px solid #8cf;}';
          document.head.appendChild(styleEl);
        }

        // code_cell's stylesheet lives in PostCardUtils.js (codeCellCss), injected when
        // that module loads, so the editor and the read-only view share one copy.

        ['keydown', 'keyup', 'keypress', 'input'].forEach(function (t) {
          pmDiv.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick'].forEach(function (t) {
          pmDiv.addEventListener(t, function (e) { e.stopPropagation(); });
        });

        if (this._autoHeight) this._applyAutoHeightLayout(shapeNode);
      },

      // autoHeight: instead of absolute-filling a fixed-size morph (toolbar
      // pinned top, footer pinned bottom, editor scrolling in between), the
      // pieces stack in normal flow so the editor takes its natural height,
      // and the morph is resized to match (_watchContentHeight) -- the page
      // grows with the content and the browser page scrolls. The toolbar is
      // position:sticky so it stays on screen while scrolling a long page.
      _applyAutoHeightLayout: function (shapeNode) {
        var flow = document.createElement('div');
        flow.style.cssText = [
          'position:relative', 'display:flex', 'flex-direction:column',
          'background:#fff', 'border-radius:8px', 'box-sizing:border-box',
        ].join(';');
        shapeNode.appendChild(flow);
        this._flowEl = flow;

        this._toolbarDiv.style.cssText = [
          // top:26px: clear of the fixed world menu bar while stuck.
          'position:sticky', 'top:26px', 'z-index:5', 'flex:0 0 auto', 'height:40px',
          'background:#f0f0f5', 'border-bottom:1px solid #ccc', 'box-sizing:border-box',
          'overflow:hidden', 'border-radius:8px 8px 0 0',
        ].join(';');
        var editorFlow = [
          // overflow-x:auto keeps one over-wide block (e.g. display math)
          // scrolling inside the editor instead of widening the whole page.
          'position:relative', 'flex:0 0 auto', 'min-height:360px', 'overflow-x:auto',
          'padding:16px 20px', 'box-sizing:border-box',
          'font-family:sans-serif', 'font-size:14px', 'line-height:1.6', 'white-space:pre-wrap',
        ].join(';');
        this._pmContainer.style.cssText = editorFlow;
        this._previewContainer.style.cssText = editorFlow + ';display:none';
        flow.appendChild(this._toolbarDiv);
        flow.appendChild(this._pmContainer);
        flow.appendChild(this._previewContainer);
        this._watchContentHeight(flow);
      },

      // Keeps the morph's height equal to the flow container's natural
      // height (see WikiView._watchContentHeight for why a ResizeObserver).
      _watchContentHeight: function (flow) {
        var self = this;
        if (this._heightObserver) this._heightObserver.disconnect();
        if (typeof ResizeObserver === 'undefined') return;
        this._heightObserver = new ResizeObserver(function () {
          var h = Math.max(200, Math.ceil(flow.getBoundingClientRect().height));
          var ext = self.getExtent();
          if (Math.abs(ext.y - h) < 1) return;
          self.setExtent(lively.pt(ext.x, h));
          if (self._onHeightChanged) self._onHeightChanged(self, h);
        });
        this._heightObserver.observe(flow);
      },

      // A single toolbar row: frequently-used flat buttons, then Style/
      // Template/More dropdowns for the long tail, then Preview pinned to
      // the right edge. Every command still dispatches through the same
      // _execToolbarCmd switch used before this reorganization -- dropdown
      // rows and flat buttons share one btnDef shape and one dispatch path.
      _buildToolbar: function (toolbarDiv) {
        var self = this;

        // Two parts side by side: the formatting buttons/menus in `row`, which
        // scrolls horizontally when the editor is narrow, and Preview / History
        // / status / Save in `actions`, which never scrolls away -- Save has to
        // stay reachable at any editor width.
        var bar = document.createElement('div');
        bar.style.cssText = [
          'position:absolute', 'top:0', 'left:6px', 'right:6px', 'bottom:0',
          'display:flex', 'align-items:center', 'gap:8px', 'padding:0 2px',
        ].join(';');
        toolbarDiv.appendChild(bar);

        var row = document.createElement('div');
        row.style.cssText = [
          'flex:1 1 auto', 'min-width:0', 'height:100%',
          'display:flex', 'align-items:center', 'gap:6px',
          'overflow-x:auto', 'overflow-y:hidden', 'white-space:nowrap',
        ].join(';');
        bar.appendChild(row);

        var actions = document.createElement('div');
        actions.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:6px;';
        bar.appendChild(actions);

        this._toggleButtons = [];

        function addButtons(defs) {
          defs.forEach(function (btnDef) {
            var label = btnDef.icon || btnDef.label;
            var w = (btnDef.icon || label.length > 1) ? 32 : 24;
            var btn = document.createElement('button');
            btn.textContent = label;
            btn.title = btnDef.title;
            btn.style.cssText = [
              'flex:0 0 auto', 'width:' + w + 'px', 'height:24px', 'padding:0',
              'font-size:12px', 'cursor:pointer', 'border:1px solid #ccc',
              'border-radius:3px', 'background:#fff',
            ].join(';');
            if (btnDef.icon) {
              // Material Symbols Rounded ligature (see CLAUDE.md's icon convention).
              btn.style.fontFamily = '"Material Symbols Rounded"';
              btn.style.fontSize = '17px';
              btn.style.lineHeight = '1';
            }
            btn.addEventListener('mousedown', function (e) {
              e.preventDefault();
              e.stopPropagation();
              self._execToolbarCmd(btnDef);
            });
            row.appendChild(btn);
            if (btnDef.cmd === 'toggleMark') {
              self._toggleButtons.push({ btn: btn, markType: btnDef.markType });
            }
          });
        }

        addButtons([
          { label: 'B', title: 'Bold',         cmd: 'toggleMark', markType: 'bold' },
          { label: 'I', title: 'Italic',        cmd: 'toggleMark', markType: 'italic' },
          { label: 'U', title: 'Underline',     cmd: 'toggleMark', markType: 'underline' },
          { label: 'S', title: 'Strikethrough', cmd: 'toggleMark', markType: 'strike' },
          { label: '`', title: 'Inline code',   cmd: 'toggleMark', markType: 'code' },
        ]);

        addButtons([
          { label: '🖼', title: 'Insert image',      cmd: 'attachment', accept: 'image/*' },
          { label: '🎬', title: 'Insert video',      cmd: 'attachment', accept: 'video/*' },
          { label: '🎵', title: 'Insert audio',      cmd: 'attachment', accept: 'audio/*' },
          { icon: 'link', title: 'Insert/remove link', cmd: 'link' },
          { icon: 'attach_file', title: 'Insert attachment', cmd: 'attachment' },
          { label: '🧩', title: 'Insert part',       cmd: 'insertPart' },
        ]);

        addButtons([
          { label: '•',  title: 'Bullet list',  cmd: 'wrapInList', nodeType: 'bullet_list' },
          { label: '1.', title: 'Ordered list', cmd: 'wrapInList', nodeType: 'ordered_list' },
          { label: '≡',  title: 'Cycle alignment (left/center/right/justify)', cmd: 'cycleAlign' },
        ]);

        this._buildDropdown(row, {
          label: 'Style',
          buildPanel: function (panel, close) {
            self._buildDropdownRow(panel, 'Paragraph', { cmd: 'setBlockType', nodeType: 'paragraph', attrs: {} }, close);
            for (var level = 1; level <= 6; level++) {
              self._buildDropdownRow(panel, 'Heading ' + level, { cmd: 'setBlockType', nodeType: 'heading', attrs: { level: level } }, close);
            }
            self._buildDropdownRow(panel, 'Blockquote', { cmd: 'wrapIn', nodeType: 'blockquote' }, close);
            self._buildDropdownRow(panel, 'Code block', { cmd: 'setBlockType', nodeType: 'code_block', attrs: {} }, close);
          },
        });

        this._buildDropdown(row, {
          label: 'Template',
          buildPanel: function (panel, close) {
            self._buildDropdownRow(panel, 'Math (inline)', { cmd: 'insertMath', mathType: 'inline' }, close);
            self._buildDropdownRow(panel, 'Math (display)', { cmd: 'insertMath', mathType: 'display' }, close);
            lively.identity.postCardUtils.codeCellLanguageList().forEach(function (def) {
              self._buildDropdownRow(panel, def.insertLabel, { cmd: 'insertCodeCell', language: def.id }, close);
            });
          },
        });

        this._buildDropdown(row, {
          label: 'More',
          buildPanel: function (panel, close) {
            self._buildDropdownRow(panel, 'Superscript', { cmd: 'toggleMark', markType: 'superscript' }, close);
            self._buildDropdownRow(panel, 'Subscript', { cmd: 'toggleMark', markType: 'subscript' }, close);
            self._buildDropdownRow(panel, 'Clear formatting', { cmd: 'clearFormatting' }, close);
            self._buildDropdownRow(panel, 'Indent', { cmd: 'indent' }, close);
            self._buildDropdownRow(panel, 'Outdent', { cmd: 'outdent' }, close);
            // Author-only, constellation pages only -- hidden until
            // _refreshPermissionsRow decides it applies.
            self._buildPermissionsRow(panel, close);

            var divider = document.createElement('div');
            divider.style.cssText = 'height:1px;background:#eee;margin:4px 2px;';
            panel.appendChild(divider);

            var colorRow = document.createElement('div');
            colorRow.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 10px;';
            self._textColorInput = self._buildColorInput('textColor', 'Text color', '#000000');
            self._bgColorInput = self._buildColorInput('backgroundColor', 'Background color', '#ffffff');
            colorRow.appendChild(self._textColorInput);
            colorRow.appendChild(self._bgColorInput);
            panel.appendChild(colorRow);

            var fontRow = document.createElement('div');
            fontRow.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 10px;';
            self._fontFamilySelect = self._buildFontFamilySelect();
            self._fontSizeInput = self._buildFontSizeInput();
            fontRow.appendChild(self._fontFamilySelect);
            fontRow.appendChild(self._fontSizeInput);
            panel.appendChild(fontRow);
          },
        });

        var previewBtn = document.createElement('button');
        previewBtn.textContent = 'Preview';
        previewBtn.title = 'Preview the current draft as it will look published';
        previewBtn.style.cssText = [
          'flex:0 0 auto', 'height:24px', 'padding:0 10px', 'font-size:12px', 'cursor:pointer',
          'border:1px solid #ccc', 'border-radius:3px', 'background:#fff',
        ].join(';');
        previewBtn.addEventListener('mousedown', function (e) {
          e.preventDefault();
          e.stopPropagation();
          self._togglePreview();
        });
        actions.appendChild(previewBtn);
        this._previewButton = previewBtn;

        this._buildSaveControls(actions);
      },

      // A native-DOM dropdown (trigger button + absolutely-positioned
      // panel), NOT the morphic Box+Text popup pattern used elsewhere in
      // this codebase (NewWikiPageDialog's Category picker, WikiIndex's
      // sort-by dropdown) -- this toolbar is deliberately plain native DOM
      // appended straight to shapeNode (see file header), kept out of
      // Lively's morph hierarchy so drag/grab can't grab it as an
      // independent morph. A morphic popup here would need constant manual
      // getBoundingClientRect() translation and risks z-order bugs once the
      // editor is embedded at an arbitrary position; a plain
      // position:absolute panel anchored to its own trigger has neither
      // problem.
      _buildDropdown: function (toolbarDiv, opts) {
        var self = this;
        // The panel is appended to shapeNode, NOT to the trigger's own
        // wrapper -- the toolbar row scrolls horizontally
        // (overflow-x:auto), which per the CSS overflow spec forces its
        // computed overflow-y to 'auto' too (an explicit non-'visible' on
        // one axis promotes 'visible' on the other to 'auto'), so any
        // dropdown panel nested inside that row would get clipped/scrolled
        // away instead of shown. Appending to shapeNode and computing its
        // position from the trigger's live getBoundingClientRect() escapes
        // that clipping entirely.
        var shapeNode = this.renderContext().shapeNode;
        var wrapper = document.createElement('div');
        wrapper.style.cssText = 'position:relative;flex:0 0 auto;';

        var trigger = document.createElement('button');
        trigger.textContent = opts.label + ' ▾';
        trigger.title = opts.label;
        trigger.style.cssText = [
          'height:24px', 'padding:0 8px', 'font-size:12px', 'cursor:pointer',
          'border:1px solid #ccc', 'border-radius:3px', 'background:#fff', 'white-space:nowrap',
        ].join(';');

        var panel = document.createElement('div');
        panel.style.cssText = [
          'position:absolute', 'min-width:150px',
          'background:#fff', 'border:1px solid #ccc', 'border-radius:4px',
          'box-shadow:0 2px 8px rgba(0,0,0,0.15)', 'z-index:10000', 'display:none',
          'padding:4px', 'box-sizing:border-box',
        ].join(';');
        shapeNode.appendChild(panel);

        function close() {
          panel.style.display = 'none';
          if (self._activeDropdown === panel) self._activeDropdown = null;
          if (self._outsideClickHandler) {
            document.removeEventListener('mousedown', self._outsideClickHandler, true);
            self._outsideClickHandler = null;
          }
        }
        function open() {
          if (self._activeDropdown && self._activeDropdown !== panel) {
            self._activeDropdown.style.display = 'none';
          }
          if (self._outsideClickHandler) {
            document.removeEventListener('mousedown', self._outsideClickHandler, true);
          }
          var triggerRect = trigger.getBoundingClientRect();
          var shapeRect = shapeNode.getBoundingClientRect();
          panel.style.left = (triggerRect.left - shapeRect.left) + 'px';
          panel.style.top = (triggerRect.bottom - shapeRect.top + 2) + 'px';
          panel.style.display = 'block';
          self._activeDropdown = panel;
          self._outsideClickHandler = function (e) {
            if (!wrapper.contains(e.target) && !panel.contains(e.target)) close();
          };
          document.addEventListener('mousedown', self._outsideClickHandler, true);
        }
        trigger.addEventListener('mousedown', function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (panel.style.display === 'block') close();
          else open();
        });

        opts.buildPanel(panel, close);
        wrapper.appendChild(trigger);
        toolbarDiv.appendChild(wrapper);
        return wrapper;
      },

      _buildDropdownRow: function (panel, label, btnDef, close) {
        var self = this;
        var row = document.createElement('div');
        row.textContent = label;
        row.style.cssText = [
          'padding:5px 10px', 'font-size:12px', 'cursor:pointer', 'border-radius:3px',
          'white-space:nowrap',
        ].join(';');
        row.addEventListener('mouseover', function () { row.style.background = '#eef4ff'; });
        row.addEventListener('mouseout', function () { row.style.background = ''; });
        row.addEventListener('mousedown', function (e) {
          e.preventDefault();
          e.stopPropagation();
          self._execToolbarCmd(btnDef);
          close();
        });
        panel.appendChild(row);
        return row;
      },

      // ─── who can edit (constellation pages, author only) ───────────────────────
      // The row in the More menu, and the small panel it opens. The panel is a
      // position:fixed native-DOM box on document.body (not inside this
      // morph's shapeNode): the toolbar is sticky, so anchoring to the shape
      // would put it wherever the top of the editor scrolled to, and CLAUDE.md's
      // notes on native inputs in overlays favour body-level dialogs.

      _buildPermissionsRow: function (panel, close) {
        var self = this;
        var row = document.createElement('div');
        row.textContent = 'Who can edit…';
        row.style.cssText = [
          'padding:5px 10px', 'font-size:12px', 'cursor:pointer', 'border-radius:3px',
          'white-space:nowrap', 'display:none',
        ].join(';');
        row.addEventListener('mouseover', function () { row.style.background = '#eef4ff'; });
        row.addEventListener('mouseout', function () { row.style.background = ''; });
        row.addEventListener('mousedown', function (e) {
          e.preventDefault();
          e.stopPropagation();
          close();
          self._openPermissionsPanel();
        });
        panel.appendChild(row);
        this._permissionsRow = row;
        return row;
      },

      // Only the page's author on a constellation page (the server refuses
      // anyone else changing the policy regardless).
      _refreshPermissionsRow: function () {
        if (!this._permissionsRow) return;
        var show = !!(this._constellation && this._isOwner && !this._forceReadOnly);
        this._permissionsRow.style.display = show ? '' : 'none';
      },

      _closePermissionsPanel: function () {
        if (this._permPanel && this._permPanel.parentNode) this._permPanel.parentNode.removeChild(this._permPanel);
        this._permPanel = null;
        if (this._permCloseHandler) {
          document.removeEventListener('mousedown', this._permCloseHandler, true);
          this._permCloseHandler = null;
        }
      },

      _openPermissionsPanel: function () {
        var self = this;
        if (this._permPanel) return this._closePermissionsPanel();
        var WP = lively.identity.WikiPolicy;
        var current = this._editPolicy || { mode: 'members' };
        var chosen = current.mode;

        var panel = document.createElement('div');
        panel.style.cssText = [
          'position:fixed', 'z-index:100000', 'width:320px', 'box-sizing:border-box',
          'background:#fff', 'border:1px solid #ccc', 'border-radius:6px',
          'box-shadow:0 4px 16px rgba(0,0,0,0.25)', 'padding:12px',
          'font:12px sans-serif', 'color:#333',
        ].join(';');

        var title = document.createElement('div');
        title.textContent = 'Who can edit this page';
        title.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:8px;';
        panel.appendChild(title);

        var handlesInput = document.createElement('input');
        handlesInput.type = 'text';
        handlesInput.placeholder = 'alice, bob, carol.example';
        handlesInput.value = (current.handles || []).join(', ');
        handlesInput.style.cssText = 'display:none;width:100%;box-sizing:border-box;margin:2px 0 6px 22px;width:calc(100% - 22px);padding:4px 6px;font-size:12px;border:1px solid #ccc;border-radius:3px;';

        function syncHandlesVisibility() { handlesInput.style.display = chosen === 'handles' ? 'block' : 'none'; }

        var group = 'wiki-perm-' + (this.id || 'editor');
        WP.MODES.forEach(function (m) {
          var label = document.createElement('label');
          label.style.cssText = 'display:block;cursor:pointer;margin:4px 0;';
          var radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = group;
          radio.checked = chosen === m.key;
          radio.style.cssText = 'margin:0 8px 0 0;vertical-align:middle;';
          radio.addEventListener('change', function () { chosen = m.key; syncHandlesVisibility(); });
          var name = document.createElement('span');
          name.textContent = m.label;
          name.style.cssText = 'font-weight:600;';
          var hint = document.createElement('div');
          hint.textContent = m.hint;
          hint.style.cssText = 'color:#888;font-size:11px;margin-left:22px;';
          label.appendChild(radio);
          label.appendChild(name);
          label.appendChild(hint);
          panel.appendChild(label);
          if (m.key === 'handles') panel.appendChild(handlesInput);
        });
        syncHandlesVisibility();

        var err = document.createElement('div');
        err.style.cssText = 'color:#c33;font-size:11px;min-height:14px;margin:4px 0;';
        panel.appendChild(err);

        var buttons = document.createElement('div');
        buttons.style.cssText = 'display:flex;justify-content:flex-end;gap:6px;';
        function button(text, primary) {
          var b = document.createElement('button');
          b.textContent = text;
          b.style.cssText = 'height:24px;padding:0 12px;font-size:12px;cursor:pointer;border-radius:3px;' +
            (primary ? 'border:1px solid #5a5;background:#efe;' : 'border:1px solid #ccc;background:#fff;');
          return b;
        }
        var cancel = button('Cancel', false), apply = button('Apply', true);
        cancel.addEventListener('click', function () { self._closePermissionsPanel(); });
        apply.addEventListener('click', function () {
          var built = WP.build(chosen, handlesInput.value);
          if (built.error) { err.textContent = built.error; return; }
          var previous = self._editPolicy;
          self._editPolicy = built.policy;
          self._closePermissionsPanel();
          // A page that hasn't been saved yet carries the policy in its first
          // save; an existing one saves now, and rolls the change back if the
          // server refuses it.
          if (self._isNew) return;
          self._saveNow(function (saveErr) {
            if (saveErr) { self._editPolicy = previous; return; }
            self._editAccess = null; // policy changed: refetch access next time
          });
        });
        buttons.appendChild(cancel);
        buttons.appendChild(apply);
        panel.appendChild(buttons);

        // Keystrokes in the handles field belong to the field, not to Lively's
        // world-level key handling.
        ['keydown', 'keyup', 'keypress'].forEach(function (t) {
          panel.addEventListener(t, function (e) { e.stopPropagation(); });
        });

        var tb = this._toolbarDiv.getBoundingClientRect();
        panel.style.top = (tb.bottom + 4) + 'px';
        panel.style.left = Math.max(8, Math.min(window.innerWidth - 328, tb.right - 328)) + 'px';
        document.body.appendChild(panel);
        this._permPanel = panel;

        this._permCloseHandler = function (e) {
          if (!panel.contains(e.target)) self._closePermissionsPanel();
        };
        document.addEventListener('mousedown', this._permCloseHandler, true);
      },

      _buildColorInput: function (markName, title, fallback) {
        var self = this;
        var input = document.createElement('input');
        input.type = 'color';
        input.title = title;
        input.value = fallback;
        input.style.cssText = 'flex:0 0 auto;width:26px;height:24px;padding:0;border:1px solid #ccc;border-radius:3px;cursor:pointer;';
        ['mousedown', 'click'].forEach(function (t) {
          input.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        input.addEventListener('input', function () {
          if (!self.editorView) return;
          var view = self.editorView;
          var markType = view.state.schema.marks[markName];
          if (!markType) return;
          var from = view.state.selection.from, to = view.state.selection.to;
          if (from === to) return;
          view.dispatch(view.state.tr.addMark(from, to, markType.create({ color: input.value })));
        });
        input.addEventListener('change', function () { if (self.editorView) self.editorView.focus(); });
        return input;
      },

      _buildFontFamilySelect: function () {
        var self = this;
        var options = [
          ['', 'Font'],
          ['sans-serif', 'Sans'],
          ['serif', 'Serif'],
          ['monospace', 'Mono'],
          ['"Comic Sans MS", cursive', 'Comic'],
          ['Georgia, serif', 'Georgia'],
        ];
        var select = document.createElement('select');
        select.title = 'Font family';
        select.style.cssText = [
          'flex:0 0 auto', 'height:24px', 'font-size:11px', 'cursor:pointer',
          'border:1px solid #ccc', 'border-radius:3px', 'background:#fff',
        ].join(';');
        options.forEach(function (opt) {
          var optionEl = document.createElement('option');
          optionEl.value = opt[0];
          optionEl.textContent = opt[1];
          select.appendChild(optionEl);
        });
        ['mousedown', 'click'].forEach(function (t) {
          select.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        select.addEventListener('change', function () {
          if (!self.editorView) return;
          var view = self.editorView;
          var markType = view.state.schema.marks.fontFamily;
          if (!markType) return;
          var from = view.state.selection.from, to = view.state.selection.to;
          if (from === to) return;
          var tr = view.state.tr.removeMark(from, to, markType);
          if (select.value) tr = tr.addMark(from, to, markType.create({ family: select.value }));
          view.dispatch(tr);
          view.focus();
        });
        return select;
      },

      _buildFontSizeInput: function () {
        var self = this;
        var input = document.createElement('input');
        input.type = 'number';
        input.title = 'Font size (px)';
        input.placeholder = '14';
        input.min = '6';
        input.max = '128';
        input.style.cssText = 'flex:0 0 auto;width:44px;height:24px;padding:0 2px;font-size:11px;' +
          'border:1px solid #ccc;border-radius:3px;background:#fff;';
        ['mousedown', 'click'].forEach(function (t) {
          input.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        function commit() {
          if (!self.editorView) return;
          var view = self.editorView;
          var markType = view.state.schema.marks.fontSize;
          if (!markType) return;
          var from = view.state.selection.from, to = view.state.selection.to;
          if (from === to) return;
          var tr = view.state.tr.removeMark(from, to, markType);
          if (input.value) tr = tr.addMark(from, to, markType.create({ size: input.value + 'px' }));
          view.dispatch(tr);
          view.focus();
        }
        input.addEventListener('change', commit);
        input.addEventListener('keydown', function (e) {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
        });
        return input;
      },

      // Footer bar: much smaller than PostCardEditor.js's — a wiki page has
      // no Send/visibility/post-to-constellation actions (see file header).
      // History, save status and Save, at the right end of the toolbar (after
      // Preview). They used to be a footer pinned to the bottom of the
      // editor, which on a page that grows with its content sits far down
      // the page, under the fixed presence panel. In the toolbar they stay
      // on screen with it (position:sticky) and clear of the panel.
      _buildSaveControls: function (row) {
        var self = this;

        var histBtn = document.createElement('button');
        histBtn.textContent = 'History';
        histBtn.title = 'Save, then view the version history';
        histBtn.style.cssText = 'flex:0 0 auto;width:64px;height:24px;padding:0;font-size:11px;cursor:pointer;border:1px solid #ccc;border-radius:3px;background:#fff;';
        histBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._openHistory();
        });
        row.appendChild(histBtn);

        var statusSpan = document.createElement('span');
        statusSpan.style.cssText = 'flex:0 0 auto;min-width:44px;text-align:right;font-size:10px;color:#888;pointer-events:none;';
        row.appendChild(statusSpan);
        this._statusEl = statusSpan;

        var saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        saveBtn.title = 'Save now';
        saveBtn.style.cssText = 'flex:0 0 auto;width:64px;height:24px;padding:0;font-size:12px;cursor:pointer;border:1px solid #5a5;border-radius:3px;background:#efe;';
        saveBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          // Only the explicit Save-button click transforms editor -> view
          // mode, never the debounced autosave (_scheduleSave) — flipping
          // to read-only every couple of seconds while someone is mid-typing
          // would make the editor unusable. this._onSaved is caller-supplied
          // (see newCard/openCard opts.onSaved) since only the embedding
          // caller (WikiIndex.js's $world slot, ConstellationCanvas.js's
          // placement wrapper) knows how to actually perform the swap —
          // WikiEditor stays agnostic to its own embedding context, and
          // can't require lively.identity.WikiView itself without a
          // require() cycle (WikiView.js already requires WikiEditor).
          self._saveNow(function (err) {
            if (!err && self._onSaved) self._onSaved(self._handle, self._objId);
          });
        });
        row.appendChild(saveBtn);
      },

      // Reflects the current selection's formatting into the toolbar —
      // identical to PostCardEditor.js's (generic ProseMirror state read).
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
          entry.btn.style.background = active ? '#dbe9ff' : '#fff';
          entry.btn.style.borderColor = active ? '#58c' : '#ccc';
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
          this._fontSizeInput.value = (sMark && sMark.attrs.size) ? parseInt(sMark.attrs.size, 10) : '';
        }
      },

      // A small floating chip shown under the cursor when it's inside a link —
      // identical to PostCardEditor.js's.
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
        link.style.cssText = 'color:#E31361;text-decoration:underline;max-width:200px;overflow:hidden;' +
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
    // Bypasses lively.morphic.Morph's default Backspace/Ctrl-C/-V handling
    // whenever the ProseMirror view itself has focus — identical rationale
    // to PostCardEditor.js's override.

    'morph events', {

      onKeyDown: function ($super, evt) {
        var view = this.editorView;
        if (view && (view.hasFocus() || (view.dom && view.dom.contains(document.activeElement)))) {
          return false;
        }
        return $super(evt);
      },

    },

    // ─── ProseMirror setup ────────────────────────────────────────────────────────

    'editor', {

      // Inject postcard-runtime.js if Yjs/PM aren't on the page yet — shared
      // runtime bundle with PostCardEditor.js, same lazy-load mechanism.
      _ensureRuntime: function (callback) {
        // Stylesheets first, before the early return below: a page that
        // already carries the runtime bundle in its own HTML (the wiki
        // index route) skips the load path, and used to end up with no
        // KaTeX/highlight CSS at all -- math rendered twice (MathML +
        // HTML) and display math at thousands of px wide.
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
        var s = document.createElement('script');
        s.src = '/core/lib/postcard/postcard-runtime.js';
        s.onload = function () { window._postcardRuntimeLoading = false; callback(); };
        s.onerror = function () {
          window._postcardRuntimeLoading = false;
          self._showError('Failed to load /core/lib/postcard/postcard-runtime.js');
        };
        document.head.appendChild(s);
      },

      // A new wiki page always gets a fresh Y.Doc — there is no plain mode
      // to fork between.
      _createNewDoc: function () {
        var self = this;
        this._ensureRuntime(function () {
          var Y = self._Y();
          if (!Y) return self._showError('Yjs not loaded — cannot create editor');
          self.yDoc = new Y.Doc({ gc: false });
          self._attachEditor();
          self._connectSync();
        });
      },

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
          if (xhr.status !== 200) return self._showError('Failed to load wiki page: ' + xhr.status);
          var envelope;
          try { envelope = JSON.parse(xhr.responseText); } catch (e) {
            return self._showError('Invalid envelope JSON: ' + e.message);
          }
          self._envelope = envelope;
          self._constellation = envelope.constellation || null;
          self._wikiName = (envelope.state && envelope.state.wikiName) || null;
          self._category = (envelope.state && envelope.state.category) || null;
          self._tags = (envelope.state && envelope.state.tags) || [];
          self._editPolicy = (envelope.state && envelope.state.editPolicy) || null;
          var user = lively.identity.did.currentUser();
          self._isOwner = !!(user && user.did === envelope.did);
          self._canEdit = self._isOwner;

          function finishLoad() {
            self._attachEditor();
            self._applyReadOnlyMode();
            self._refreshPermissionsRow();
            self._connectSync();
            if (self._restore) self._applyRestoreWhenReady();
          }

          function onDeserialized(err, doc, payload, info) {
            if (err) return self._showError('Failed to deserialize: ' + err.message);
            if (info && info.cidMismatch) {
              // Non-fatal by design -- see deserializeFromEnvelope's comment.
              // WikiView's own signature-based badge is the real trust
              // signal for this page; just note it happened.
              console.warn('[WikiEditor] CID mismatch for objId=' + self._objId + ' (loading anyway; see WikiSerializer.js deserializeFromEnvelope)');
            }
            self.yDoc = doc;
            self._attachments = (payload && payload.attachments) || [];

            // Resolve edit access before attaching the editor, so a
            // legitimate editor doesn't get stuck read-only. The server
            // decides (owner, or constellation member allowed by this page's
            // edit policy -- WikiPermissions.js), not this client; if that
            // request fails, fall back to the conservative owner-only default
            // already in _canEdit.
            self._fetchEditAccess(function (access) {
              if (access) {
                self._canEdit = !!access.canEdit;
                self._readOnlyReason = access.reason || null;
              }
              finishLoad();
            });
          }

          lively.identity.wikiSerializer.deserializeFromEnvelope(envelope, onDeserialized);
        };
        xhr.onerror = function () { self._showError('Network error loading wiki page'); };
        xhr.send();
      },

      // Append a ProseMirror EditorView to _pmContainer, bound to yDoc via
      // ySyncPlugin — undo/redo goes through yUndoPlugin (tracks the CRDT's
      // own undo stack), never prosemirror-history (which would fight over
      // document state with no shared doc to reconcile against).
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

        var yPM = this._yProsemirror();
        if (!yPM) return this._showError('y-prosemirror not loaded');
        var yXmlFragment = this.yDoc.getXmlFragment('prosemirror');
        var plugins = [
          yPM.ySyncPlugin(yXmlFragment),
          yPM.yUndoPlugin(), // sole undo/redo — do NOT add prosemirror history() alongside this
          this._buildHighlightPlugin(prosemirror),
          this._buildLinkPreviewPlugin(prosemirror),
          prosemirror.keymap.keymap({ 'Mod-z': yPM.undo, 'Mod-y': yPM.redo, 'Mod-Shift-z': yPM.redo }),
          prosemirror.keymap.keymap({ 'Shift-Enter': hardBreakCmd }),
          prosemirror.keymap.keymap(prosemirror.commands.baseKeymap),
        ];

        var sl = prosemirror.schemaList;
        if (sl && schema.nodes.list_item) {
          plugins.unshift(prosemirror.keymap.keymap({
            'Enter':     sl.splitListItem(schema.nodes.list_item),
            'Tab':       sl.sinkListItem(schema.nodes.list_item),
            'Shift-Tab': sl.liftListItem(schema.nodes.list_item),
          }));
        }

        this.editorView = new prosemirror.view.EditorView(this._pmContainer, {
          state: prosemirror.state.EditorState.create({ schema: schema, plugins: plugins }),
          nodeViews: {
            math_inline:  function (node, view, getPos) { return self._mathNodeView(node, view, getPos); },
            math_display: function (node, view, getPos) { return self._mathNodeView(node, view, getPos); },
            embeddedPart: function (node, view, getPos) { return self._embeddedPartNodeView(node, view, getPos); },
            link_preview_card: function (node, view, getPos) { return self._linkPreviewCardNodeView(node, view, getPos); },
            image:        function (node, view, getPos) { return self._attachmentImageNodeView(node, view, getPos); },
            video:        function (node, view, getPos) { return self._attachmentVideoNodeView(node, view, getPos); },
            audio:        function (node, view, getPos) { return self._attachmentAudioNodeView(node, view, getPos); },
            code_cell:    function (node, view, getPos) { return self._codeCellNodeView(node, view, getPos); },
          },
          handleDOMEvents: {
            blur: function () { self._hideLinkPreview(); return false; },
            click: function (view, event) {
              var a = event.target && event.target.closest && event.target.closest('a[data-attachment-obj-id]');
              if (!a) return false;
              event.preventDefault();
              self._openAttachment(a.getAttribute('data-attachment-obj-id'));
              return true;
            },
          },
          dispatchTransaction: function (tr) {
            var view = self.editorView || this;
            var newState = view.state.apply(tr);
            view.updateState(newState);
            if (tr.docChanged) self._markEdited();
            self._updateToolbarState();
            self._updateLinkPreview();
          },
        });
        this._updateToolbarState();
        this._updateLinkPreview();
      },

      // Syntax-highlights code_block content via inline Decorations —
      // identical to PostCardEditor.js's.
      _buildHighlightPlugin: function (prosemirror) {
        var Plugin = prosemirror.state.Plugin;
        var PluginKey = prosemirror.state.PluginKey;
        var Decoration = prosemirror.view.Decoration;
        var DecorationSet = prosemirror.view.DecorationSet;
        var key = new PluginKey('postcardHighlight');

        function highlightCodeBlock(pos, text) {
          var hljs = (typeof window !== 'undefined' && window.hljs) || null;
          if (!hljs || !text) return [];
          var result;
          try { result = hljs.highlightAuto(text); } catch (e) { return []; }
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

      // Live "link preview" card while composing — mirrors
      // PostCardEditor.js's own copy (see that file's header comment for
      // the full rationale on the decoration -> persisted-node design)
      // with two Yjs-specific additions neither needed in plain mode:
      //   - a dedup claim-check in yDoc.getMap('linkPreviewInserts') before
      //     ever dispatching the insert, narrowing (not fully closing) the
      //     window where two collaborators both convert the same bare-url
      //     paragraph at nearly the same moment — same Y.Map-alongside-the-
      //     ySyncPlugin-fragment pattern as _embedStateApi's partState map.
      //     blocksToHtml's/computeDecorations's adjacent-same-url collapse
      //     (PostCardUtils.js, computeDecorations below) makes the residual
      //     cross-client race cosmetic rather than a lasting duplicate.
      //   - yUndoPluginKey's undoManager.stopCapturing() instead of
      //     prosemirror-history's closeHistory(tr) — same goal (the insert
      //     must not silently merge into — or get silently orphaned from —
      //     whatever undo-group timing happens to be in progress), different
      //     API because wiki mode's undo stack is Y.UndoManager, not
      //     prosemirror-history.
      _buildLinkPreviewPlugin: function (prosemirror) {
        var self = this;
        var Plugin = prosemirror.state.Plugin;
        var PluginKey = prosemirror.state.PluginKey;
        var Decoration = prosemirror.view.Decoration;
        var DecorationSet = prosemirror.view.DecorationSet;
        var key = new PluginKey('wikiLinkPreview');
        var BARE_URL_RE = /^(https?:\/\/[^\s<>"']+)$/i;
        var LINK_PREVIEW_FETCH_DEBOUNCE_MS = 600;
        // Mirrors PostCardEditor.js's own copy of this same fix -- see that
        // file's header comment for the full rationale (confirmed live:
        // typing a 44-char YouTube URL fired 35 real outbound requests, one
        // per keystroke, 14 of them 502ing, and a mid-typed garbage video id
        // could briefly resolve to a real-but-bogus heavyweight embed).
        // Keyed by paragraph start position, not url (which changes every
        // keystroke and so can't dedupe against itself).
        var _fetchDebounceTimers = {};

        function scheduleFetch(pos, url) {
          if (_fetchDebounceTimers[pos]) clearTimeout(_fetchDebounceTimers[pos]);
          _fetchDebounceTimers[pos] = setTimeout(function () {
            delete _fetchDebounceTimers[pos];
            var view = self.editorView;
            if (!view) return;
            var node = view.state.doc.nodeAt(pos);
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

        function hasSiblingCard(doc, endPos, url) {
          var next = doc.nodeAt(endPos);
          return !!(next && next.type.name === 'link_preview_card' && next.attrs.url === url);
        }

        function requestRefresh() {
          var view = self.editorView;
          if (!view) return;
          view.dispatch(view.state.tr.setMeta(key, true));
        }

        function computeDecorations(state) {
          var U = lively.identity.postCardUtils;
          var decos = [];
          state.doc.descendants(function (node, pos) {
            if (node.type.name !== 'paragraph') return true;
            var url = bareUrlOf(node);
            if (!url) return false;
            var widgetPos = pos + node.nodeSize;
            var cached = U.peekLinkPreview(url);
            if (cached === undefined) {
              // Cache cold -- the resolved url isn't known yet (see the BUG
              // FIX note below), but a sibling card here can only exist
              // from an earlier resolution of this same paragraph, so the
              // bare-url check is a safe (if occasionally over-cautious)
              // early bail.
              if (hasSiblingCard(state.doc, widgetPos, url)) return false;
              scheduleFetch(pos, url);
              return false;
            }
            if (_fetchDebounceTimers[pos]) { clearTimeout(_fetchDebounceTimers[pos]); delete _fetchDebounceTimers[pos]; }
            if (cached === null || cached.err || !cached.body || cached.body.error) return false;
            // BUG FIX (hand-mirrored from PostCardEditor.js's identical
            // fix — caught live there: a pasted Reddit share link
            // duplicated its own card endlessly, masked here only by
            // maybeCommit's claimInsert Yjs guard below, which happens to
            // be keyed by the bare url rather than this mismatch): match
            // against the server-RESOLVED url (cached.body.url), not the
            // originally pasted/typed text — a redirecting link (Reddit
            // share links, any shortlink) resolves to a different final
            // url than what's still sitting in the paragraph.
            if (hasSiblingCard(state.doc, widgetPos, cached.body.url)) return false;
            decos.push(Decoration.widget(widgetPos, function () {
              return U.buildLinkPreviewCard(cached.body);
            }, { key: 'link-preview-' + url, side: 1, stopEvent: function () { return true; } }));
            return false;
          });
          return DecorationSet.create(state.doc, decos);
        }

        // Synchronous get()-then-set() claim on a url -- no await between
        // the two, so no other code on THIS client can interleave. Fully
        // prevents a single client's own debounced re-checks from double-
        // inserting; narrows but can't fully close the cross-client window
        // (see this function's own header comment).
        function claimInsert(url) {
          if (!self.yDoc) return true; // yDoc gone (editor tearing down) -- let the stale check below no-op harmlessly
          var claims = self.yDoc.getMap('linkPreviewInserts');
          if (claims.get(url)) return false;
          claims.set(url, Date.now());
          return true;
        }

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
            if (sel.from <= end && sel.to >= start) return false;
            var cached = U.peekLinkPreview(url);
            if (!cached || cached.err || !cached.body || cached.body.error) return false;
            // BUG FIX: see computeDecorations' identical fix above — match
            // against the resolved cached.body.url, not the bare pasted
            // text, or a redirecting link never recognizes its own
            // already-inserted card. claimInsert below (keyed by the bare
            // url) happens to prevent runaway duplication from this same
            // mismatch within one client session, but shouldn't be relied
            // on as the only guard — a remote client's own insert lands
            // here as a doc change too, and this check is what recognizes
            // it as already-done rather than racing claimInsert again.
            if (hasSiblingCard(state.doc, end, cached.body.url)) return false;
            found = { endPos: end, url: url, body: cached.body };
            return false;
          });
          if (!found) return;
          if (!claimInsert(found.url)) return;
          var nodeType = state.schema.nodes.link_preview_card;
          var tr = state.tr.insert(found.endPos, nodeType.create({
            url: found.body.url || '', title: found.body.title || null,
            description: found.body.description || null, image: found.body.image || null,
            siteName: found.body.siteName || null, provider: found.body.provider || null,
            embedUrl: found.body.embedUrl || null, bluesky: found.body.bluesky || null,
          }));
          var yPM = self._yProsemirror && self._yProsemirror();
          if (yPM && yPM.yUndoPluginKey) {
            var undoState = yPM.yUndoPluginKey.getState(state);
            if (undoState && undoState.undoManager) undoState.undoManager.stopCapturing();
          }
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

      // NodeView for math_inline/math_display — identical to PostCardEditor.js's.
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

        dom.addEventListener('mousedown', function (e) {
          if (editing) return;
          e.preventDefault();
          startEditing();
        });

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

      // Runnable Python cell (CodeEditorSpec.md §2.3). Modeled on
      // _mathNodeView's commit()-on-blur/Escape pattern for writing edits
      // back to node attrs, plus _embeddedPartNodeView's `destroyed`-guard
      // discipline for callbacks that can outlive this NodeView (a Run
      // request the user navigated away from mid-flight). `output` is never
      // written to node.attrs -- it's plain closure state here, same
      // lifetime as `dom` (see the schema comment for why: Yjs would
      // broadcast it to every collaborator on every run, and it's never
      // persisted anyway).
      _codeCellNodeView: function (node, view, getPos) {
        var destroyed = false;
        var focused = false;
        var pendingCommitTimer = null;

        var postCardUtils = lively.identity.postCardUtils;
        // The language's registry row (PostCardUtils.js). A language this build has no row for
        // (`known` false) keeps its id and its editable source but gets no Run/Stop/Reset/status.
        var langDef = postCardUtils.codeCellLanguage(node.attrs.language);
        var language = langDef.id;

        var dom = document.createElement('div');
        dom.className = 'lively-code-cell-node';
        dom.setAttribute('data-language', language);

        var header = document.createElement('div');
        header.className = 'lively-code-cell-header';
        var badge = document.createElement('span');
        badge.className = 'lively-code-cell-badge';
        badge.textContent = langDef.label;
        var runBtn = document.createElement('button');
        runBtn.type = 'button';
        runBtn.className = 'lively-code-cell-run-btn';
        runBtn.textContent = 'Run';
        var stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'lively-code-cell-stop-btn';
        stopBtn.textContent = 'Stop';
        var resetBtn = null;
        if (langDef.hasReset) {
          resetBtn = document.createElement('button');
          resetBtn.type = 'button';
          resetBtn.className = 'lively-code-cell-reset-btn';
          resetBtn.textContent = 'Reset';
          resetBtn.title = langDef.resetTitle;
        }
        var status = document.createElement('span');
        status.className = 'lively-code-cell-status';
        status.textContent = 'Idle';
        header.appendChild(badge);
        if (langDef.known) {
          header.appendChild(runBtn);
          header.appendChild(stopBtn);
          if (resetBtn) header.appendChild(resetBtn);
          header.appendChild(status);
        }
        dom.appendChild(header);

        var textarea = document.createElement('textarea');
        textarea.className = 'lively-code-cell-source';
        textarea.spellcheck = false;
        textarea.value = node.attrs.source || '';
        dom.appendChild(textarea);
        // A language with an editing helper (Scheme: bracket matching, auto-close and Lisp
        // indentation) gets it; the others keep the plain textarea.
        var editingHelper = postCardUtils.codeCellGlobal(langDef.editing);
        var editing = editingHelper ? editingHelper.attach(textarea) : null;

        // Grow/shrink the source box with its content, between the stylesheet's min-height (72px) and
        // MAX_H, beyond which it scrolls inside itself. Measures scrollHeight after collapsing the
        // box, so the horizontal scrollbar (a long line) is allowed for via offsetHeight - clientHeight.
        // The collapse would briefly shorten the page, which can clamp the window's scroll position,
        // so the box's parent is pinned at its current height for the duration of the measure.
        var MAX_H = 520;
        var LINE_H = 13 * 1.55, PAD_Y = 28;
        var lastAutosizeWidth = -1;
        function autosize() {
          if (destroyed) return;
          var h;
          if (textarea.isConnected && textarea.offsetHeight > 0) {
            var holder = textarea.parentNode;
            var holderH = holder.offsetHeight;
            var prevScroll = textarea.scrollTop;
            holder.style.minHeight = holderH + 'px';
            textarea.style.height = 'auto';
            h = textarea.scrollHeight + (textarea.offsetHeight - textarea.clientHeight);
            holder.style.minHeight = '';
            textarea.scrollTop = prevScroll;
          } else {
            // Not laid out yet (a NodeView's dom is detached until ProseMirror inserts it): estimate
            // from the line count, and the ResizeObserver below corrects it once it is on screen.
            h = Math.ceil(textarea.value.split('\n').length * LINE_H + PAD_Y);
          }
          var capped = h > MAX_H;
          textarea.style.height = Math.min(h, MAX_H) + 'px';
          textarea.style.overflowY = capped ? 'auto' : 'hidden';
        }
        autosize();
        if (typeof ResizeObserver === 'function') {
          // Width changes can add/remove the horizontal scrollbar (and the first layout after
          // insertion arrives here too); height changes are our own and ignored.
          var resizeObserver = new ResizeObserver(function () {
            var w = textarea.offsetWidth;
            if (w !== lastAutosizeWidth) { lastAutosizeWidth = w; autosize(); }
          });
          resizeObserver.observe(textarea);
        }

        var output = document.createElement('div');
        output.className = 'lively-code-cell-output lively-code-cell-output-empty';
        output.textContent = langDef.known
          ? 'Run to see output.'
          : 'This page uses a runtime this build doesn\'t have, so this cell can\'t run.';
        dom.appendChild(output);
        if (langDef.known && langDef.help) {
          var help = document.createElement('div');
          help.className = 'lively-code-cell-help';
          help.textContent = langDef.help;
          dom.appendChild(help);
        }

        // Same pattern as _mathNodeView's commit(): re-reads getPos() at
        // commit time rather than caching it, since positions shift under
        // concurrent edits from other collaborators.
        function commit() {
          if (pendingCommitTimer) { clearTimeout(pendingCommitTimer); pendingCommitTimer = null; }
          var value = textarea.value;
          if (value === node.attrs.source) return;
          var pos = typeof getPos === 'function' ? getPos() : null;
          if (pos === null || pos === undefined) return;
          view.dispatch(view.state.tr.setNodeMarkup(pos, null,
            Object.assign({}, node.attrs, { source: value })));
        }

        // A multi-line cell risks real data loss on tab-close without this
        // (unlike math's single-value input) -- debounce-commit while
        // typing, on top of the blur/Escape commits below.
        function scheduleCommit() {
          if (pendingCommitTimer) clearTimeout(pendingCommitTimer);
          pendingCommitTimer = setTimeout(commit, 600);
        }

        textarea.addEventListener('mousedown', function (e) { e.stopPropagation(); });
        textarea.addEventListener('focus', function () { focused = true; });
        textarea.addEventListener('blur', function () { focused = false; commit(); });
        textarea.addEventListener('input', function () { scheduleCommit(); autosize(); });
        textarea.addEventListener('keydown', function (e) {
          e.stopPropagation();
          if (e.key === 'Escape') { e.preventDefault(); commit(); view.focus(); }
        });

        function renderOutput(response, err) {
          output.innerHTML = '';
          output.classList.remove('lively-code-cell-output-empty');
          var hasContent = false;
          if (response && response.stdout) {
            var stdoutPre = document.createElement('pre');
            stdoutPre.className = 'lively-code-cell-stdout';
            stdoutPre.textContent = response.stdout;
            output.appendChild(stdoutPre);
            hasContent = true;
          }
          (response && response.images || []).forEach(function (b64) {
            var img = document.createElement('img');
            img.src = 'data:image/png;base64,' + b64;
            output.appendChild(img);
            hasContent = true;
          });
          if (response && response.result != null) {
            var resultPre = document.createElement('pre');
            resultPre.className = 'lively-code-cell-result';
            resultPre.textContent = response.result;
            output.appendChild(resultPre);
            hasContent = true;
          }
          if (response && response.stderr) {
            var stderrPre = document.createElement('pre');
            stderrPre.className = 'lively-code-cell-stderr';
            stderrPre.textContent = response.stderr;
            output.appendChild(stderrPre);
            hasContent = true;
          }
          if (err) {
            var errPre = document.createElement('pre');
            errPre.className = 'lively-code-cell-stderr';
            errPre.textContent = err.message || String(err);
            output.appendChild(errPre);
            hasContent = true;
          }
          if (!hasContent) {
            output.classList.add('lively-code-cell-output-empty');
            output.textContent = 'Ran with no output.';
          }
        }

        function setRunning(isRunning, statusText) {
          runBtn.style.display = isRunning ? 'none' : '';
          stopBtn.style.display = isRunning ? 'inline-block' : 'none';  // '' would fall back to the stylesheet's display:none
          if (resetBtn) resetBtn.style.display = isRunning ? 'none' : '';
          status.textContent = statusText;
        }

        // Transcript languages (Scheme) stream an ordered transcript (stdout / value / error)
        // and can pause for a line of input; see postCardUtils.createSchemeOutput.
        var transcriptOut = langDef.output === 'transcript' ? postCardUtils.createSchemeOutput(output) : null;
        var TRANSCRIPT_STATE_LABEL = { done: 'Ran just now', error: 'Error', stopped: 'Stopped', exit: 'Exited' };
        function runTranscriptCell() {
          transcriptOut.start();
          postCardUtils.runCodeCell(textarea.value, {
            onStatus: function (text) { if (!destroyed) setRunning(true, text); },
            onSegments: function (segments) { if (!destroyed) transcriptOut.append(segments); },
            onDraw: function (ops, turtle) { if (!destroyed) transcriptOut.draw(ops, turtle); },
            onNeedInput: function () {
              if (destroyed) { postCardUtils.provideCodeCellInput(null, language); return; }
              setRunning(true, 'Waiting for input…');
              transcriptOut.showInput(function (text) {
                if (!destroyed) setRunning(true, 'Running…');
                postCardUtils.provideCodeCellInput(text, language);
              });
            },
            onDone: function (err, result) {
              if (destroyed) return;
              var state = result && result.state;
              setRunning(false, err ? 'Error' : (TRANSCRIPT_STATE_LABEL[state] || 'Ran just now'));
              transcriptOut.finish(state, err);
            },
          }, language);
        }

        // Click-to-run, always -- CodeEditorSpec.md §2.3: a cell never
        // auto-executes, not even for the page's own author, and there is
        // no remembered-trust bypass (a wiki page's source can change
        // between two clicks). The confirm dialog + Pyodide Worker
        // orchestration lives once in postCardUtils.runCodeCell, shared with
        // this file's own hydrateCodeCells (read-only view/preview) rather
        // than hand-copied a second time here.
        runBtn.addEventListener('mousedown', function (e) {
          e.preventDefault();
          e.stopPropagation();
          commit();
          if (transcriptOut) { runTranscriptCell(); return; }
          lively.identity.postCardUtils.runCodeCell(textarea.value, {
            onStatus: function (text) { if (!destroyed) setRunning(true, text); },
            onDone: function (err, response) {
              if (destroyed) return;
              setRunning(false, err ? 'Error' : 'Ran just now');
              renderOutput(response, err);
            },
          }, language);
        });

        stopBtn.addEventListener('mousedown', function (e) {
          e.preventDefault();
          e.stopPropagation();
          // A cooperative stop (Scheme): the run's own onDone reports the
          // outcome (and the environment survives). Python's is an immediate
          // worker kill, so this handler updates the UI itself.
          if (postCardUtils.stopCodeCell(language)) setRunning(true, 'Stopping…');
          else setRunning(false, 'Stopped');
        });

        if (resetBtn) {
          resetBtn.addEventListener('mousedown', function (e) {
            e.preventDefault();
            e.stopPropagation();
            postCardUtils.resetCodeCell(language, function () {
              if (!destroyed) setRunning(false, 'Environment reset');
            });
          });
        }

        return {
          dom: dom,
          update: function (newNode) {
            if (newNode.type !== node.type) return false;
            // The badge, Reset button and editing helpers were built for one language: a cell of
            // another language needs a fresh view, not this one relabelled by the document.
            if (postCardUtils.codeCellLanguage(newNode.attrs.language).id !== language) return false;
            var sourceChanged = newNode.attrs.source !== node.attrs.source;
            node = newNode;
            // Don't clobber an in-flight local edit on an incoming
            // collaborator update -- same care _attachmentImageNodeView's
            // diff-before-re-render already takes.
            if (sourceChanged && !focused) {
              textarea.value = node.attrs.source || '';
              if (editing) editing.refresh();
              autosize();
            }
            return true;
          },
          selectNode: function () { dom.classList.add('lively-code-cell-selected'); },
          deselectNode: function () { dom.classList.remove('lively-code-cell-selected'); commit(); },
          // Also swallow events inside the output pane, so a Scheme cell's
          // inline input box gets its keystrokes and clicks.
          stopEvent: function (e) { return focused || !!(e && e.target && output.contains(e.target)); },
          ignoreMutation: function () { return true; },
          destroy: function () {
            destroyed = true;
            if (pendingCommitTimer) clearTimeout(pendingCommitTimer);
            if (resizeObserver) resizeObserver.disconnect();
            if (editing) editing.destroy();
          },
        };
      },

      // Reversibly makes the editor inert and visually dimmed -- shared by
      // _applyReadOnlyMode's permanent (non-writer) case and Preview mode's
      // temporary case below. Unlike _applyReadOnlyMode, this never resizes
      // or wipes the toolbar/footer DOM, so Preview can flip it back
      // instantly with the exact same controls still in place.
      _setChromeDisabled: function (disabled, opts) {
        var except = (opts && opts.except) || [];
        if (this.editorView) {
          this.editorView.setProps({ editable: function () { return !disabled; } });
        }
        [this._toolbarDiv, this._footerDiv].forEach(function (container) {
          if (!container) return;
          var controls = container.querySelectorAll('button, select, input');
          for (var i = 0; i < controls.length; i++) {
            var el = controls[i];
            if (except.indexOf(el) !== -1) continue;
            el.disabled = disabled;
            el.style.opacity = disabled ? '0.4' : '';
          }
        });
      },

      // Toggles between the live ProseMirror editor and a read-only render
      // of the CURRENT unsaved draft, in place. _extractSnapshot reads the
      // live in-memory Y.Doc directly -- independent of _scheduleSave's
      // debounce timer, so this always reflects exactly what's on screen,
      // never a stale last-saved version, with no need to flush/await an
      // autosave first. The real EditorView is only hidden, never destroyed
      // or recreated, so cursor position/undo history survive the
      // round-trip and Save always persists from it, never from
      // _previewContainer's disconnected HTML copy.
      _togglePreview: function () {
        if (!this._previewContainer || !this._pmContainer) return;
        if (!this._previewMode) {
          var snapshot = this.yDoc ? lively.identity.wikiSerializer._extractSnapshot(this.yDoc) : null;
          this._previewContainer.innerHTML = snapshot ? lively.identity.postCardUtils.snapshotToHtml(snapshot) : '';
          lively.identity.postCardUtils.hydrateEmbeddedParts(this._previewContainer);
          lively.identity.postCardUtils.hydrateCodeCells(this._previewContainer);
          lively.identity.postCardUtils.hydrateLinkPreviewEmbeds(this._previewContainer);
          lively.identity.postCardUtils.hydrateLinkPreviews(this._previewContainer);
          this._previewContainer.style.top = this._pmContainer.style.top;
          this._previewContainer.style.bottom = this._pmContainer.style.bottom;
          this._pmContainer.style.display = 'none';
          this._previewContainer.style.display = 'block';
          this._previewMode = true;
          this._setChromeDisabled(true, { except: [this._previewButton] });
          if (this._previewButton) this._previewButton.textContent = 'Continue Editing';
        } else {
          this._previewContainer.style.display = 'none';
          this._pmContainer.style.display = '';
          this._previewMode = false;
          this._setChromeDisabled(false);
          if (this._previewButton) this._previewButton.textContent = 'Preview';
        }
      },

      // Makes the view read-only for a viewer without write access (not the
      // owner, and not a constellation member with canWrite).
      _applyReadOnlyMode: function () {
        if (this._canEdit && !this._forceReadOnly) return;
        this._setChromeDisabled(true);
        if (this._toolbarDiv) {
          this._toolbarDiv.innerHTML = '';
          this._toolbarDiv.style.cssText = [
            this._autoHeight ? 'position:sticky; z-index:5; flex:0 0 auto; top:26px' : 'position:absolute; left:0; right:0; top:0',
            'height:28px',
            'background:#f0f0f5', 'border-bottom:1px solid #ccc',
            'box-sizing:border-box', 'display:flex', 'align-items:center', 'padding:0 10px',
          ].join(';');
          var label = document.createElement('span');
          label.style.cssText = 'font-size:11px;color:#888;font-family:sans-serif;';
          label.textContent = lively.identity.WikiPolicy.readOnlyMessage(this._readOnlyReason, this._constellation);
          this._toolbarDiv.appendChild(label);
        }
        if (this._pmContainer && !this._autoHeight) {
          this._pmContainer.style.top = '28px';
          this._pmContainer.style.bottom = '0';
        }
      },

      // Connects to LiveDocSyncServer via WebsocketProvider for live
      // multi-writer collaboration. Gracefully degrades if y-websocket is
      // unavailable.
      // Asks the server whether THIS session may edit the page and, if so, for
      // a signed token the live-edit sync room requires before it accepts
      // edits (GET /@:handle/:objId/edit-token -- see IdentityServer.js).
      // Calls thenDo({ canEdit, reason, policy, token? }), or thenDo(null) if
      // the request failed. Cached in _editAccess; pass force to refetch.
      _fetchEditAccess: function (thenDo, force) {
        var self = this;
        if (this._editAccess && !force) return thenDo(this._editAccess);
        if (!this._objId || !this._handle) return thenDo(null);
        var url = lively.identity.did.baseUrl() + '/@' + encodeURIComponent(this._handle) +
          '/' + encodeURIComponent(this._objId) + '/edit-token';
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.withCredentials = true;
        xhr.onload = function () {
          var data = null;
          if (xhr.status === 200) {
            try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
          }
          self._editAccess = data;
          thenDo(data);
        };
        xhr.onerror = function () { thenDo(null); };
        xhr.send();
      },

      _connectSync: function () {
        if (!this._objId) return; // no sync until first save establishes objId
        if (!this.yDoc) return;
        if (this.wsProvider) return;
        var self = this;
        // The edit token decides whether the room accepts our edits or treats
        // this connection as read-only, so it has to be in hand before
        // connecting (no token = read-only, which is right for a viewer).
        this._fetchEditAccess(function (access) {
          self._startSyncProvider(access && access.canEdit ? access.token : null);
        });
      },

      _startSyncProvider: function (token) {
        if (this.wsProvider) return;
        var WebsocketProvider = this._WebsocketProvider();
        if (!WebsocketProvider) {
          console.warn('[WikiEditor] WebsocketProvider not loaded — live sync disabled');
          return;
        }

        // Same origin/port as the page itself -- LiveDocSyncServer.js rides
        // the shared WS listener under /livedoc-sync/, no separate port to
        // configure or inject any more.
        var wsScheme = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss:' : 'ws:';
        var wsUrl = wsScheme + '//' + location.host + '/livedoc-sync';
        var self = this;
        try {
          this.wsProvider = new WebsocketProvider(wsUrl, this._objId, this.yDoc, {
            connect: true,
            params: token ? { token: token } : {},
          });
          this.wsProvider.on('status', function (event) {
            console.log('[WikiEditor] sync status:', event.status);
          });
        } catch (e) {
          console.warn('[WikiEditor] Failed to start WebSocket sync (non-fatal):', e.message);
          return;
        }

        // y-websocket reconnects by reusing the URL it was built with, token
        // included, and the token expires (8h). Refresh it well before that so
        // a long editing session that drops and reconnects still has a valid
        // one. (If the fresh answer is "may not edit any more", the URL drops
        // the token and the next reconnect is read-only.)
        clearInterval(this._tokenTimer);
        this._tokenTimer = setInterval(function () {
          if (!self.world() || !self.wsProvider) return clearInterval(self._tokenTimer);
          self._fetchEditAccess(function (access) {
            if (!self.wsProvider) return;
            var t = access && access.canEdit ? access.token : null;
            self.wsProvider.url = wsUrl + '/' + self._objId + (t ? '?token=' + encodeURIComponent(t) : '');
          }, true);
        }, 6 * 60 * 60 * 1000);
      },

      // Mirrors WikiView.js's getOutline() exactly, but reads from this
      // editor's own live ProseMirror-rendered DOM (_pmContainer) instead
      // of WikiView's read-only _contentEl — lets WikiIndex.js's "On this
      // page" sidebar work identically whether the currently-open inline
      // view is the read-only WikiView or this editable WikiEditor.
      getOutline: function () {
        if (!this._pmContainer) return [];
        return Array.prototype.map.call(
          this._pmContainer.querySelectorAll('h1, h2, h3, h4, h5, h6'),
          function (el) {
            return { level: parseInt(el.tagName.substring(1), 10), text: el.textContent || '', el: el };
          },
        );
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
        // A wiki-mode PUT can legitimately succeed for a non-owner
        // constellation member (§16.6), so this mirrors _canEdit's fuller
        // condition, not just ownership.
        if (!this._canEdit || this._forceReadOnly) return;
        this._userHasEdited = true;
        this._scheduleSave();
      },

      // callback: optional (err) — invoked after PUT completes/fails.
      _stateMeta: function () {
        var meta = { category: this._category, tags: this._tags || [] };
        if (this._editPolicy && this._constellation) meta.editPolicy = this._editPolicy;
        return meta;
      },

      // Saves are serialized: a save requested while another is still in
      // flight (it can sit for many seconds on the first-save WebAuthn
      // ceremony, see WebAuthn.deriveKek) waits for it, then runs once more
      // so it builds on the envelope that save produced. Without this the
      // second save started from the same stale `this._envelope` -- for a
      // brand-new page that is null, so it minted a SECOND genesis objId and
      // the page got created twice (two rows, same wikiName); for an existing
      // page it chained off the same prevCid and was rejected with a 409.
      // Everything requested during the wait coalesces into a single re-run,
      // and each caller's callback fires after the save that covers its edits.
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
        if (!this.editorView) { this._setStatus('No document'); return cb(new Error('No document')); }
        this._saveInFlight = Date.now();

        var params = {
          prevEnvelope:  this._envelope || null,
          constellation: this._constellation,
          wikiName:      this._wikiName,
          yDoc:          this.yDoc,
          attachments:   this._attachments || [],
          // serializeToEnvelope replaces envelope.state wholesale from
          // stateMeta each save (no merge with prevEnvelope.state) — so
          // category/tags must be re-sent on every autosave, not just at
          // creation, or they'd be silently wiped on the very next save.
          // editPolicy rides along for the same reason (and only when one was
          // ever set; absent means "all members").
          stateMeta:     this._stateMeta(),
          // title omitted — WikiSerializer extracts it from the first PM block
        };
        this._setStatus('Saving…');
        lively.identity.wikiSerializer.serializeToEnvelope(params, function (err, envelope) {
          self._finishSave(err, envelope, cb);
        });
      },

      _finishSave: function (err, envelope, callback) {
        var self = this;
        var cb = callback || function () {};
        if (err) {
          console.error('[WikiEditor] serialize error:', err && (err.message || String(err)));
          self._setStatus('Error');
          return cb(err);
        }
        self._putEnvelope(envelope, function (putErr) {
          if (putErr) {
            console.error('[WikiEditor] PUT error:', putErr && (putErr.message || String(putErr)));
            self._setStatus('Error');
            return cb(putErr);
          }
          self._envelope = envelope;
          self._objId = envelope.objId;
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
        console.log('[WikiEditor] PUT', url, 'objId:', envelope.objId);
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status === 200 || xhr.status === 201) return callback(null);
          console.error('[WikiEditor] PUT failed', xhr.status, xhr.responseText.slice(0, 300));
          callback(new Error('PUT failed: ' + xhr.status));
        };
        xhr.onerror = function () {
          console.error('[WikiEditor] PUT network error');
          callback(new Error('Network error'));
        };
        xhr.send(JSON.stringify(envelope));
      },

    },

    // ─── embedded parts ─────────────────────────────────────────────────────────
    // Identical to PostCardEditor.js's — parts are Lively Morphs, deserialized
    // and mounted directly into this editor's own DOM/JS realm.

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

      // Inserts a block-level atom (code cell, display math, video, audio, embedded part) at
      // the selection. replaceSelectionWith alone gets two things wrong:
      //  1. with a node selected (the atom left selected by the previous insert) it replaces
      //     that node instead of adding beside it, and
      //  2. when the new atom is the last node there is no text position after it, so
      //     ProseMirror leaves the selection ON the atom -- which sets up (1) for the next insert.
      // So: a node selection inserts after the node, and an atom with no text block after it
      // gets an empty paragraph that takes the caret. Cost, measured in Preview: that paragraph is
      // 0px tall but its 16px bottom margin shows below the last block; it is added only when no text
      // block follows, so repeated inserts do not pile up paragraphs.
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
            // BUG FIX: see PostCardEditor.js's identical fix — a Lively
            // morph's shapeNode is position:absolute, so it never
            // contributes to contentDiv's flow height, and the outer
            // .lively-embedded-part-node's overflow:hidden clips everything
            // past its min-height:32px regardless of the morph's real size.
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

      // NodeView for the persisted link_preview_card node — mirrors
      // PostCardEditor.js's own copy exactly (see that file's comment for
      // the full rationale: modeled on _embeddedPartNodeView, not the
      // click-to-edit _mathNodeView; click-swallowing comes from
      // buildLinkPreviewCard's own internal listeners, not a NodeView-level
      // stopEvent).
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
          if (!currentNode.attrs.objId) return;

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
              console.error('[WikiEditor] attachment image resolve failed:', err);
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
          if (!currentNode.attrs.objId) return;

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
              console.error('[WikiEditor] attachment video resolve failed:', err);
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
          if (!currentNode.attrs.objId) return;

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
              console.error('[WikiEditor] attachment audio resolve failed:', err);
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

      // Per-embed shared state, backed by a nested Y.Map at
      // yDoc.getMap('partState').get(embedId) — always the Yjs path, since
      // a WikiEditor instance is never anything else. Multiple writers can
      // observe each other's changes live, and playback replays it for
      // free (same Yjs update blob as the rest of the document).
      _embedStateApi: function (embedId) {
        if (!embedId) return null;
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
      },

    },

    // ─── toolbar commands ─────────────────────────────────────────────────────────
    // Identical to PostCardEditor.js's — generic ProseMirror commands plus
    // the attachment-upload flow, neither of which are postcard-specific.

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
          case 'insertCodeCell': {
            var cellType = state.schema.nodes.code_cell;
            if (!cellType) return;
            var cellDef = lively.identity.postCardUtils.codeCellLanguage(btnDef.language);
            var cellNode = cellType.create({ language: cellDef.known ? cellDef.id : 'python', source: '' });
            this._insertBlockAtom(cellNode);
            break;
          }
          case 'cycleAlign': {
            var alignOrder = ['left', 'center', 'right', 'justify'];
            var $ap = state.selection.$from;
            var alignNode = $ap.parent;
            if (alignNode.attrs.align === undefined) return;
            var nextAlign = alignOrder[(alignOrder.indexOf(alignNode.attrs.align) + 1) % alignOrder.length];
            dispatch(state.tr.setNodeMarkup($ap.before($ap.depth), null,
              Object.assign({}, alignNode.attrs, { align: nextAlign })));
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
            this._promptAttachment(btnDef.accept);
            break;
          }
          case 'insertPart': {
            if (this._openPartsPicker) this._openPartsPicker();
            else alert('Insert part — coming soon');
            break;
          }
        }
        view.focus();
      },

      _promptLink: function () {
        if (!this.editorView) return;
        var view = this.editorView;
        var state = view.state;
        var linkType = state.schema.marks.link;
        if (!linkType) return;
        var from = state.selection.from, to = state.selection.to;
        if (from === to) return;
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
        if (href === null) return;
        href = href.trim();
        var tr = state.tr.removeMark(from, to, linkType);
        if (href) tr = tr.addMark(from, to, linkType.create({ href: href }));
        view.dispatch(tr);
        view.focus();
      },

      // accept: optional file-picker MIME filter (e.g. 'image/*') -- purely
      // a UX narrowing of the native picker; _uploadAttachment's own
      // isImage/isVideo/isAudio MIME sniff (below) still decides the actual
      // schema node type regardless of what accept was passed here.
      _promptAttachment: function (accept) {
        var self = this;
        var input = document.createElement('input');
        input.type = 'file';
        if (accept) input.accept = accept;
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', function () {
          var file = input.files && input.files[0];
          if (input.parentNode) input.parentNode.removeChild(input);
          if (file) self._uploadAttachment(file);
        });
        input.click();
      },

      // Wiki pages are always public/unencrypted (WikiSerializer.js), so
      // attachments never need recipient key-sealing the way a
      // private/shared postcard's do.
      _uploadAttachment: function (file) {
        var self = this;
        if (!this._handle) return;
        var isImage = /^image\//.test(file.type || '');
        var isVideo = /^video\//.test(file.type || '');
        var isAudio = /^audio\//.test(file.type || '');

        this._setStatus('Uploading…');
        lively.identity.fileCrypto.encryptAndUpload(file, {
          visibility: 'public',
          recipients: [],
          onWaiting: function () { self._setStatus('Confirm passkey…'); },
        }, function (err, result) {
          if (err) {
            self._setStatus('Upload failed');
            console.error('[WikiEditor] attachment upload failed:', err);
            return;
          }
          var entry = {
            objId: result.objId,
            dek: result.dek ? lively.identity.crypto.base64urlEncode(result.dek) : null,
            blobCid: result.blobCid,
            blobNonce: result.blobNonce,
            name: file.name,
            mime: file.type || 'application/octet-stream',
          };
          if (!self._attachments) self._attachments = [];
          self._attachments.push(entry);
          if (isImage) self._insertAttachmentImage(entry);
          else if (isVideo) self._insertAttachmentVideo(entry);
          else if (isAudio) self._insertAttachmentAudio(entry);
          else self._insertAttachmentLink(entry);
          self._setStatus('Uploaded');
        });
      },

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

      _openAttachment: function (objId) {
        var self = this;
        var entry = (this._attachments || []).find(function (a) { return a.objId === objId; });
        if (!entry) return;
        this._setStatus('Decrypting…');
        lively.identity.fileCrypto.resolveAttachmentUrl(this._handle, entry, function (err, url) {
          if (err) {
            self._setStatus('Failed to open attachment');
            console.error('[WikiEditor] attachment open failed:', err);
            return;
          }
          self._setStatus('');
          window.open(url, '_blank');
        });
      },

    },

    // ─── history ──────────────────────────────────────────────────────────────────

    'history', {

      // The editor has no history view of its own: the version list lives in
      // WikiView (WikiHistory.js). Flush any pending edit so the list includes
      // it, then hand over to the caller (the same swap a Save click does) with
      // `openHistory` set so the read-only view comes up on the history panel.
      _openHistory: function () {
        var self = this;
        if (!this._objId) return alert('Save the page first before viewing history.');
        if (!this._onSaved) return alert('History opens from the read-only page view.');
        this._saveNow(function (err) {
          if (!err) self._onSaved(self._handle, self._objId, { openHistory: true });
        });
      },

    },

    // ─── restore ──────────────────────────────────────────────────────────────────
    // openCard's opts.restore = { snapshot, attachments }: an older version's
    // content, handed over by the history panel. Done through the editor rather
    // than by serializing the old payload directly, because a Yjs document only
    // ever grows -- "going back" has to be a new edit on top of the current
    // state (replace the whole document), and it has to happen on the live
    // synced doc so peers in the page's sync room receive it too.

    'restore', {

      // Waits for the sync room to hand over its state first (so the edit is
      // made on top of whatever is already there, not beside it); gives up
      // waiting after ~5s (room unreachable) and applies to the loaded state.
      _applyRestoreWhenReady: function () {
        var self = this, tries = 0;
        (function wait() {
          var p = self.wsProvider;
          if (!(p && p.synced) && tries++ < 50) return setTimeout(wait, 100);
          self._applyRestore();
        })();
      },

      _applyRestore: function () {
        var self = this;
        var r = this._restore;
        this._restore = null;
        if (!r || !r.snapshot) return;
        if (!this._canEdit || this._forceReadOnly) {
          return alert('You do not have permission to edit this page, so it cannot be restored.');
        }
        var prosemirror = this._ProseMirror(), view = this.editorView;
        if (!view || !prosemirror) return alert('The editor is not ready, so the version could not be restored.');
        var doc;
        try {
          doc = prosemirror.model.Node.fromJSON(view.state.schema, r.snapshot);
          doc.check();
        } catch (e) {
          return alert('That version cannot be restored: ' + (e && e.message || e));
        }
        // Blobs the old content points at must stay resolvable from the new version.
        var known = {};
        this._attachments = this._attachments || [];
        this._attachments.forEach(function (a) { known[a.objId] = true; });
        (r.attachments || []).forEach(function (a) {
          if (!known[a.objId]) self._attachments.push(a);
        });
        view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
        this._saveNow(function (err) {
          if (!err && self._onSaved) self._onSaved(self._handle, self._objId);
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
        if (typeof window === 'undefined') return null;
        if (window.PM) return window.PM;
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

      // Same schema PostCardEditor.js builds — prose nodes + math +
      // embeddedPart + image attachments. Kept as a separate copy rather
      // than a shared module (see file header on the toolbar/schema
      // duplication tradeoff).
      _buildSchema: function (modelModule) {
        return new modelModule.Schema({
          nodes: {
            doc:          { content: 'block+' },
            paragraph:    { group: 'block', content: 'inline*',
                            attrs: { align: { default: 'left' }, indent: { default: 0 } },
                            parseDOM: [{ tag: 'p', getAttrs: _parseAlignIndent }],
                            toDOM: function(n) { return ['p', _alignIndentAttrs(n), 0]; } },
            heading:      { group: 'block', content: 'inline*',
                            attrs: { level: { default: 1 }, align: { default: 'left' } },
                            parseDOM: [1,2,3,4,5,6].map(function(l) {
                              return { tag: 'h'+l, attrs: { level: l }, getAttrs: _parseAlignIndent };
                            }),
                            toDOM: function(n) {
                              var attrs = _alignIndentAttrs(n);
                              return ['h'+n.attrs.level, attrs, 0];
                            } },
            bullet_list:  { group: 'block', content: 'list_item+',
                            parseDOM: [{ tag: 'ul' }], toDOM: function() { return ['ul', 0]; } },
            ordered_list: { group: 'block', content: 'list_item+', attrs: { order: { default: 1 } },
                            parseDOM: [{ tag: 'ol' }], toDOM: function() { return ['ol', 0]; } },
            list_item:    { content: 'paragraph block*', attrs: { indent: { default: 0 } },
                            parseDOM: [{ tag: 'li', getAttrs: _parseAlignIndent }],
                            toDOM: function(n) { return ['li', _alignIndentAttrs(n), 0]; } },
            blockquote:   { group: 'block', content: 'block+',
                            parseDOM: [{ tag: 'blockquote' }], toDOM: function() { return ['blockquote', 0]; } },
            code_block:   { group: 'block', content: 'text*', marks: '',
                            parseDOM: [{ tag: 'pre' }],
                            toDOM: function() { return ['pre', ['code', { class: 'hljs' }, 0]]; } },
            math_inline:  { group: 'inline', inline: true, atom: true,
                            attrs: { value: { default: '' } },
                            parseDOM: [{ tag: 'code.math-inline', getAttrs: function(d) { return { value: d.textContent }; } }],
                            toDOM: function(n) { return ['code', { class: 'math-inline' }, n.attrs.value]; } },
            math_display: { group: 'block', atom: true,
                            attrs: { value: { default: '' } },
                            parseDOM: [{ tag: 'pre.math-display', getAttrs: function(d) { return { value: d.textContent }; } }],
                            toDOM: function(n) { return ['pre', { class: 'math-display' }, n.attrs.value]; } },
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
            // Persisted link-preview card — mirrors PostCardEditor.js's
            // _buildSchema node-for-node (see that file's comment for the
            // full rationale). embedUrl/provider set only for a recognized
            // Spotify/YouTube/SoundCloud/Apple Music link.
            link_preview_card: { group: 'block', atom: true,
                            attrs: { url: { default: '' }, title: { default: null },
                                     description: { default: null }, image: { default: null },
                                     siteName: { default: null }, provider: { default: null },
                                     embedUrl: { default: null }, bluesky: { default: null } },
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
            // Runnable Python cell (CodeEditorSpec.md §2.3) -- deliberately
            // its own atom node, not an overload of the plain-text
            // code_block above: it needs a Run button/output pane/busy
            // state a plain PM text-content node can't carry. `output` is
            // NOT an attr here on purpose (see _codeCellNodeView) -- a
            // page's saved state is only ever {language, source}, per the
            // "never persist output" decision in the spec.
            code_cell:    { group: 'block', atom: true,
                            attrs: { language: { default: 'python' }, source: { default: '' } },
                            parseDOM: [{ tag: 'div.lively-code-cell', getAttrs: function(d) {
                              var pre = d.querySelector('pre.lively-code-cell-source');
                              return { language: d.getAttribute('data-language') || 'python',
                                       source: pre ? pre.textContent : '' };
                            }}],
                            toDOM: function(n) {
                              return ['div', { class: 'lively-code-cell', 'data-language': n.attrs.language || 'python' },
                                ['pre', { class: 'lively-code-cell-source' }, n.attrs.source || '']];
                            } },
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
        console.log('[WikiEditor] status:', msg);
        if (this._statusEl) this._statusEl.textContent = msg;
        if (this._statusLabel) this._statusLabel.textString = msg;
      },

      _showError: function (msg) {
        console.error('[WikiEditor]', msg);
        this._setStatus('Error');
      },

    });

    // ─── class-side entry points ─────────────────────────────────────────────────

    Object.extend(WikiEditorClass, {

      // Same pattern as WikiView's _openInWorld/_currentWorldView (see that
      // file): when no opts.target is given, the editor opens as a plain
      // self-rendering Box directly in the world, no lively.morphic.Window
      // chrome, centered on the visible world bounds. Only one standalone
      // editor is ever in the world at a time — opening another removes
      // whichever one is already there first.
      _currentWorldEditor: null,

      _openInWorld: function (editor) {
        if (WikiEditorClass._currentWorldEditor && WikiEditorClass._currentWorldEditor.world()) {
          WikiEditorClass._currentWorldEditor.remove();
        }
        WikiEditorClass._currentWorldEditor = editor;
        var extent = editor.getExtent();
        editor.openInWorld(lively.morphic.World.current().visibleBounds().center().subPt(extent.scaleBy(0.5)));
        // To the back, as in WikiView._openInWorld: the page is the backdrop of
        // its world, and windows and the menu bar belong above it.
        editor.sendToBack();
      },

      // Load an existing wiki page and open the editor.
      // opts.forceReadOnly: used only by WikiView to embed this editor
      // purely as a render engine for content — strips all editing chrome
      // and disables autosave regardless of ownership.
      // opts.onSaved(handle, objId, extra): fires once, only after an explicit
      // Save-button click succeeds (never from the debounced autosave) —
      // lets an embedding caller swap this editor for a read-only view in
      // place. See _buildSaveControls's Save handler. Also fires after the
      // History button's save and after a restore's save; extra.openHistory is
      // set for the former, and the caller should open the new view on its
      // history panel (WikiView.open's opts.openHistory).
      // opts.restore ({snapshot, attachments}): an older version's content to
      // apply and save as a new version once loaded -- see _applyRestore.
      openCard: function (handle, objId, options) {
        var opts = options || {};
        var editor = new lively.identity.WikiEditor(opts.bounds || lively.rect(0, 0, 1180, 780));
        editor._handle = handle;
        editor._objId = objId;
        editor._isNew = false;
        editor._forceReadOnly = !!opts.forceReadOnly;
        editor._restore = opts.restore || null;
        editor._onSaved = opts.onSaved || null;
        editor._autoHeight = !!opts.autoHeight;
        editor._onHeightChanged = opts.onHeightChanged || null;
        if (opts.target) {
          opts.target.addMorph(editor);
          editor._setup();
        } else {
          WikiEditorClass._openInWorld(editor);
          editor._setup();
        }
        return editor;
      },

      // Create a new genesis wiki page and open the editor.
      // options: { constellation, wikiName, category, tags } — wikiName is
      // required; constellation is optional (omitted entirely for a
      // personal/home-world page — see WikiSerializer.js's now-optional
      // constellation param). Mode-switching isn't supported, so a wiki
      // page's constellation/name are fixed from the moment it's created
      // (matches PostcardDesignSpec-v2.md §1.3's "no path to convert a
      // plain card into a wiki page or vice versa"). category/tags are
      // editable afterward (unlike constellation/wikiName), but need an
      // initial value from the creating dialog same as any other field.
      // opts.onSaved: see openCard's identical option above.
      newCard: function (handle, options) {
        var opts = options || {};
        var editor = new lively.identity.WikiEditor(opts.bounds || lively.rect(0, 0, 1180, 780));
        editor._handle = handle;
        editor._objId = null;
        editor._isNew = true;
        editor._constellation = opts.constellation || null;
        editor._wikiName = opts.wikiName || null;
        editor._category = opts.category || null;
        editor._tags = opts.tags || [];
        editor._editPolicy = opts.editPolicy || null;
        editor._onSaved = opts.onSaved || null;
        editor._autoHeight = !!opts.autoHeight;
        editor._onHeightChanged = opts.onHeightChanged || null;
        if (opts.target) {
          opts.target.addMorph(editor);
          editor._setup();
        } else {
          WikiEditorClass._openInWorld(editor);
          editor._setup();
        }
        return editor;
      },

    });

  }); // end module('lively.identity.WikiEditor')
