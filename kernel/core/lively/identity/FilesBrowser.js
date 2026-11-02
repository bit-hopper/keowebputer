/**
 * lively.identity.FilesBrowser
 *
 * Browser for the user's encrypted-by-default file space (Encryption.md §5),
 * plus the encrypted-folder container model (Encryption.md §15). Files are
 * "file"-type envelopes and folders are "folder"-type envelopes (both listed
 * via the home manifest, GET /@:handle) whose bytes live in the content-
 * addressed BlobStore (PUT/GET/DELETE /@:handle/blobs/:cid) — see
 * lively.identity.FileCrypto for the encrypt-before-upload / decrypt-after-
 * fetch logic, and its 'folder' section for create/fetch/add/remove/rename.
 *
 * Uploads default to private (§0 goal: encrypted unless explicitly public);
 * an "Upload as public" checkbox opts a given upload out for cases like
 * banners that must stay anonymously fetchable (ProfileCard.js handles
 * avatars/banners itself, always passing visibility: 'public' explicitly —
 * see FileCrypto.encryptAndUpload). Folders can never be public (§15's
 * container model has no public-member shape), so the public toggle is
 * hidden while browsing inside one.
 *
 * A folder is a single-level container (no nesting). Moving a flat file into
 * a folder re-encrypts it under the folder's own fixed dek and deletes the
 * original blob — there's no "attach existing blob" shortcut, since a flat
 * file and a folder member never share ciphertext; moving a member back out
 * mints it a fresh standalone dek. See FileCrypto.moveFileIntoFolder /
 * moveFileOutOfFolder. Folder deletion is intentionally not offered here —
 * see DeployCheckList.md.
 *
 * Entry point:
 *   lively.identity.FilesBrowser.open()
 */

module('lively.identity.FilesBrowser')
  .requires(
    'lively.identity.DID',
    'lively.identity.FileCrypto',
    'lively.identity.FilePreview',
    'lively.identity.WarpDrop',
  )
  .toRun(function () {

    var IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
    var PREVIEWABLE_EXTS = IMAGE_EXTS.concat(
      ['txt', 'json', 'md', 'js', 'css', 'html', 'csv', 'log'],
      ['mp3', 'wav', 'ogg'],
      ['mp4', 'webm', 'mov'],
    );

    // Rough file-family buckets, shared by the per-item icon (_iconFor) and
    // the "Group by type" listing mode. 'other' (last) is the fallback and
    // deliberately has no extension list of its own.
    var FAMILIES = [
      { key: 'audio', label: 'Audio', icon: 'audio_file', exts: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] },
      { key: 'video', label: 'Video', icon: 'video_file', exts: ['mp4', 'webm', 'mov', 'avi', 'mkv'] },
      { key: 'image', label: 'Images', icon: 'image', exts: IMAGE_EXTS },
      { key: 'archive', label: 'Archives', icon: 'folder_zip', exts: ['zip', 'rar', '7z', 'tar', 'gz'] },
      { key: 'pdf', label: 'PDFs', icon: 'picture_as_pdf', exts: ['pdf'] },
      { key: 'text', label: 'Text', icon: 'description', exts: ['txt', 'md', 'log'] },
      { key: 'code', label: 'Code', icon: 'code', exts: ['js', 'css', 'html', 'json', 'csv'] },
      { key: 'other', label: 'Other', icon: 'draft', exts: [] },
    ];
    function familyFor(ext) {
      for (var i = 0; i < FAMILIES.length - 1; i++) {
        if (FAMILIES[i].exts.indexOf(ext) !== -1) return FAMILIES[i];
      }
      return FAMILIES[FAMILIES.length - 1];
    }

    // Modern content design system for the toolbar / cards / buttons —
    // same token-and-component approach as PostCardMailbox.js's own
    // _ensureMailboxContentStyle (see that file for the fuller writeup),
    // duplicated here under its own `.fls-root`/`fls-*` prefix rather than
    // shared, since these are independent windows/modules — matches this
    // codebase's existing tolerance for small per-module style copies
    // (see LocalMap.js's _ensureGeoRuntime comment). Blue accent, distinct
    // from Mailbox's green and Wallet's purple. The public/private badge
    // pair deliberately uses its own fixed warn/neutral colors rather than
    // this accent token, so the two stay visually distinct regardless of
    // which color a given window's accent happens to be.
    function _ensureFilesContentStyle() {
      var STYLE_ID = 'files-browser-content-style';
      if (document.getElementById(STYLE_ID)) return;
      var styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.textContent = [
        '.fls-root {',
        '  --fls-bg: #fafafa; --fls-surface: #ffffff;',
        '  --fls-border: #e4e4e7; --fls-border-strong: #d4d4d8;',
        '  --fls-text: #18181b; --fls-text-secondary: #52525b; --fls-text-tertiary: #a1a1aa;',
        '  --fls-accent: #2563eb; --fls-accent-soft: #eff6ff; --fls-accent-soft-border: #bfdbfe;',
        '  --fls-danger: #e11d48; --fls-danger-soft: #fff1f2; --fls-danger-soft-border: #fecdd3;',
        '  --fls-warn: #b45309; --fls-warn-soft: #fffbeb; --fls-warn-soft-border: #fde68a;',
        '  --fls-radius: 12px; --fls-radius-sm: 8px; --fls-radius-pill: 999px;',
        '  --fls-shadow-card: 0 1px 2px rgba(24,24,27,0.04), 0 1px 8px rgba(24,24,27,0.04);',
        '  --fls-shadow-card-hover: 0 2px 6px rgba(24,24,27,0.06), 0 4px 16px rgba(24,24,27,0.08);',
        '  --fls-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;',
        '  font-family: var(--fls-font);',
        '}',
        '.fls-content::-webkit-scrollbar { width: 9px; height: 9px; }',
        '.fls-content::-webkit-scrollbar-thumb { background: var(--fls-border-strong); border-radius: 5px; border: 2px solid var(--fls-bg); }',
        '.fls-content::-webkit-scrollbar-track { background: transparent; }',

        '.fls-toolbar { display: flex; flex-direction: column; height: 100%; }',
        '.fls-toolbar-row { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 14px; box-sizing: border-box; }',
        '.fls-toolbar-row-secondary { height: 40px; border-top: 1px solid var(--fls-border); }',
        '.fls-toolbar-label { flex: 1; color: var(--fls-text); font-weight: 600; font-size: 12.5px; }',
        '.fls-breadcrumb { display: flex; align-items: center; flex: 1; font-weight: 600; font-size: 12.5px; color: var(--fls-text); min-width: 0; }',
        '.fls-crumb-link { cursor: pointer; padding: 2px 6px; border-radius: 6px; }',
        '.fls-crumb-link:hover { text-decoration: underline; }',
        '.fls-crumb-sep { font-family: "Material Symbols Rounded"; font-size: 12px; color: var(--fls-text-tertiary); margin: 0 2px; }',

        '.fls-toggle { font-size: 11.5px; color: var(--fls-text-secondary); display: flex; align-items: center;',
        '  gap: 5px; cursor: pointer; user-select: none; white-space: nowrap; }',
        '.fls-toggle input { accent-color: var(--fls-accent); }',

        '.fls-status { font-size: 11px; color: var(--fls-text-tertiary); white-space: nowrap; }',

        '.fls-select { font-size: 11.5px; padding: 4px 6px; border-radius: 6px; border: 1px solid var(--fls-border);',
        '  background: var(--fls-surface); color: var(--fls-text-secondary); font-family: var(--fls-font); }',
        '.fls-view-toggle { display: flex; gap: 4px; }',

        '.fls-card { background: var(--fls-surface); border: 1px solid var(--fls-border);',
        '  border-radius: var(--fls-radius); padding: 12px 14px; margin-bottom: 8px; position: relative;',
        '  box-shadow: var(--fls-shadow-card); transition: box-shadow .15s, border-color .15s; }',
        '.fls-card:hover { box-shadow: var(--fls-shadow-card-hover); border-color: var(--fls-border-strong); }',
        '.fls-card.dragover, .fls-tile.dragover, .fls-crumb-link.dragover {',
        '  outline: 2px dashed var(--fls-accent); outline-offset: 2px; background: var(--fls-accent-soft); }',

        '.fls-empty { display: flex; flex-direction: column; align-items: center; justify-content: center;',
        '  gap: 8px; color: var(--fls-text-tertiary); padding: 48px 16px; text-align: center; font-size: 12.5px; }',
        '.fls-empty-icon { font-family: "Material Symbols Rounded"; font-size: 32px; color: var(--fls-border-strong); }',
        '.fls-empty.danger { color: var(--fls-danger); }',
        '.fls-empty.danger .fls-empty-icon { color: var(--fls-danger); }',

        '.fls-group-header { font-size: 11px; font-weight: 700; color: var(--fls-text-tertiary);',
        '  text-transform: uppercase; letter-spacing: .03em; margin: 14px 0 6px; }',
        '.fls-group-header:first-child { margin-top: 0; }',

        '.fls-btn { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 500;',
        '  padding: 5px 11px; cursor: pointer; border-radius: var(--fls-radius-pill); border: 1px solid var(--fls-border);',
        '  background: var(--fls-surface); color: var(--fls-text-secondary); font-family: var(--fls-font);',
        '  transition: background .15s, border-color .15s, color .15s; white-space: nowrap; }',
        '.fls-btn:hover { background: var(--fls-bg); }',
        '.fls-btn:disabled { opacity: .5; cursor: default; }',
        '.fls-btn-icon-glyph { font-family: "Material Symbols Rounded"; font-size: 13px; line-height: 1; }',
        '.fls-btn-icon-only { padding: 5px 7px; }',
        '.fls-btn-accent { border-color: var(--fls-accent-soft-border); color: var(--fls-accent); background: var(--fls-accent-soft); }',
        '.fls-btn-accent:hover { background: var(--fls-accent-soft-border); }',
        '.fls-btn-danger { border-color: var(--fls-danger-soft-border); color: var(--fls-danger); background: var(--fls-danger-soft); }',
        '.fls-btn-danger:hover { background: var(--fls-danger-soft-border); }',
        '.fls-btn-ghost-danger { border-color: var(--fls-border); color: var(--fls-danger); background: var(--fls-surface); }',
        '.fls-btn-ghost-danger:hover { background: var(--fls-danger-soft); border-color: var(--fls-danger-soft-border); }',

        '.fls-badge { display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px; font-size: 10px;',
        '  font-weight: 600; border-radius: var(--fls-radius-pill); background: var(--fls-bg); color: var(--fls-text-tertiary); }',
        '.fls-badge-icon { font-family: "Material Symbols Rounded"; font-size: 11px; line-height: 1; }',
        '.fls-badge-public { background: var(--fls-warn-soft); color: var(--fls-warn); }',
        // Neutral rather than tied to --fls-accent, so it stays distinct
        // from the accent-colored buttons regardless of which color a
        // given window's accent happens to be (see comment above).
        '.fls-badge-private { background: var(--fls-border); color: var(--fls-text-secondary); }',

        '.fls-file-icon { width: 38px; height: 38px; border-radius: var(--fls-radius-sm); flex: none;',
        '  display: flex; align-items: center; justify-content: center; background: var(--fls-bg);',
        '  color: var(--fls-text-tertiary); font-family: "Material Symbols Rounded"; font-size: 19px; }',
        '.fls-file-thumb { width: 38px; height: 38px; object-fit: cover; border-radius: var(--fls-radius-sm);',
        '  flex: none; border: 1px solid var(--fls-border); box-sizing: border-box; }',

        '.fls-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 10px; margin-bottom: 12px; }',
        '.fls-tile { position: relative; display: flex; flex-direction: column; align-items: center;',
        '  background: var(--fls-surface); border: 1px solid var(--fls-border); border-radius: var(--fls-radius);',
        '  padding: 12px 8px 8px; cursor: pointer; box-shadow: var(--fls-shadow-card); transition: box-shadow .15s, border-color .15s; }',
        '.fls-tile:hover { box-shadow: var(--fls-shadow-card-hover); border-color: var(--fls-border-strong); }',
        '.fls-tile-icon { width: 48px; height: 48px; border-radius: var(--fls-radius-sm); display: flex;',
        '  align-items: center; justify-content: center; background: var(--fls-bg); color: var(--fls-text-tertiary);',
        '  font-family: "Material Symbols Rounded"; font-size: 24px; margin-bottom: 8px; }',
        '.fls-tile-thumb { width: 48px; height: 48px; object-fit: cover; border-radius: var(--fls-radius-sm); }',
        '.fls-tile-name { font-size: 11px; color: var(--fls-text); text-align: center; word-break: break-all;',
        '  max-height: 2.6em; overflow: hidden; }',
        '.fls-tile-menu { position: absolute; top: 4px; right: 4px; }',

        '.fls-popup { position: fixed; z-index: 100000; background: var(--fls-surface); border: 1px solid var(--fls-border);',
        '  border-radius: var(--fls-radius-sm); box-shadow: var(--fls-shadow-card-hover); padding: 4px; min-width: 170px;',
        '  font-family: var(--fls-font); font-size: 12px; }',
        '.fls-popup-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 6px;',
        '  cursor: pointer; color: var(--fls-text); }',
        '.fls-popup-item:hover { background: var(--fls-bg); }',
        '.fls-popup-item.danger { color: var(--fls-danger); }',
        '.fls-popup-icon { font-family: "Material Symbols Rounded"; font-size: 14px; }',
        '.fls-popup-sep { height: 1px; background: var(--fls-border); margin: 4px 0; }',
      ].join('\n');
      document.head.appendChild(styleEl);
    }

    // Same accent-chrome fix DMChat.js/Wallet.js/PostCardMailbox.js already
    // apply (title-text contrast + suppressing the base theme's white
    // focus-ring border on `.highlighted`) — see PostCardMailbox.js's own
    // _ensureAccentChromeCss for the confirmed-live bug writeup this
    // pattern fixes.
    function _ensureAccentChromeCss() {
      var STYLE_ID = 'files-browser-accent-chrome-style';
      if (document.getElementById(STYLE_ID)) return;
      var styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.textContent = [
        '.Window.files-accent-chrome { background-color: #2563EB !important; }',
        '.Window.files-accent-chrome .Text.window-title { color: #fff; }',
        '.Window.files-accent-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }',
        '.Window.files-accent-chrome.highlighted { border: none !important; box-shadow: 0px 3px 10px rgba(10,30,80,0.35) !important; }',
      ].join('\n');
      document.head.appendChild(styleEl);
    }

    var FilesBrowserClass = lively.morphic.Box.subclass('lively.identity.FilesBrowser',

    'serialization', {
      doNotSerialize: ['_contentDiv', '_toolbarDiv', '_uploadStatusSpan'],
    },

    'initialization', {

      initialize: function ($super, bounds) {
        $super(bounds);
        this._contentDiv = null;
        this._toolbarDiv = null;
        this._files = []; // raw file-type envelopes from the home manifest
        this._folders = []; // raw folder-type envelopes from the home manifest
        this._currentFolder = null; // { objId, name } while browsing inside a folder
        this._folderItems = []; // decrypted member entries of _currentFolder
        this._viewMode = 'list'; // 'list' | 'grid'
        this._sortBy = 'date'; // 'name' | 'type' | 'size' | 'date'
        this._sortDir = 'desc'; // 'asc' | 'desc'
        this._groupByType = false;
        this._sizeCache = {}; // objId -> decrypted size, for on-demand "sort by size"
        this._dragPayload = null; // { kind, item } while a drag is in progress
        this._dragHoverEl = null; // currently highlighted drop-target element, if any
        this._buildChrome();
        this._loadListing();
      },

      // Chrome (title bar, close button) is now the real classic
      // lively.morphic.Window this morph is framed in via openInWindow()
      // below — see CalendarApp.js's identical precedent — so this only
      // builds the toolbar / content area, not a hand-rolled title bar.
      _buildChrome: function () {
        _ensureFilesContentStyle();
        this.setFill(Color.white);
        this.setDroppingEnabled(false);
        var shapeNode = this.renderContext().shapeNode;
        shapeNode.classList.add('fls-root');

        var toolbarDiv = document.createElement('div');
        toolbarDiv.style.cssText = [
          'position:absolute', 'top:0', 'left:0', 'right:0', 'height:84px',
          'background:var(--fls-surface)', 'border-bottom:1px solid var(--fls-border)',
          'box-sizing:border-box',
        ].join(';');
        shapeNode.appendChild(toolbarDiv);
        this._toolbarDiv = toolbarDiv;

        var contentDiv = document.createElement('div');
        contentDiv.className = 'fls-content';
        contentDiv.style.cssText = [
          'position:absolute', 'top:84px', 'left:0', 'right:0', 'bottom:0',
          'overflow-y:auto', 'padding:14px 16px', 'box-sizing:border-box',
          'font-family:var(--fls-font)', 'font-size:13px', 'background:var(--fls-bg)',
        ].join(';');
        shapeNode.appendChild(contentDiv);
        this._contentDiv = contentDiv;

        this._renderToolbar();
      },

      // Centered icon + message — same helper shape as
      // PostCardMailbox.js's _emptyHtml/_emptyEl.
      _emptyHtml: function (icon, text, danger) {
        return '<div class="fls-empty' + (danger ? ' danger' : '') + '"><span class="fls-empty-icon">' + icon + '</span><div>' + text + '</div></div>';
      },

      // ── data fetching ─────────────────────────────────────────────────────

      // Loads either the root listing (files + top-level folders) or, while
      // browsing inside a folder, that folder's decrypted member list.
      // `thenDo` (optional) fires once the underlying data is in — before
      // any on-demand size decryption a subsequent sort might trigger — so
      // callers that just need `_files`/`_folders` refreshed (e.g. after
      // creating a folder) don't have to wait on that.
      _loadListing: function (thenDo) {
        var self = this;
        var handle = lively.identity.did.currentUser().handle;
        this._contentDiv.innerHTML = this._emptyHtml('hourglass_top', 'Loading…');

        if (this._currentFolder) {
          lively.identity.fileCrypto.fetchFolder(handle, this._currentFolder.objId, function (err, folder) {
            if (err) return self._showError(err.message);
            self._currentFolder.name = folder.name;
            self._folderItems = folder.files;
            self._renderToolbar();
            self._renderContent();
            if (thenDo) thenDo();
          });
          return;
        }

        var base = lively.identity.did.baseUrl();
        // Accept header is required here, not optional: GET /@:handle content-
        // negotiates between the JSON object listing and an HTML profile-card
        // page (IdentityServer.js), and a fetch() with no explicit Accept
        // sends "*/*", which that route's req.accepts(["html","json"]) then
        // resolves to "html" (first match wins) — silently handing this res.json()
        // call an HTML page to parse, hence "Unexpected token '<'".
        fetch(base + '/@' + handle, { credentials: 'include', headers: { 'Accept': 'application/json' } })
          .then(function (res) {
            if (!res.ok) throw new Error('Could not load files (' + res.status + ')');
            return res.json();
          })
          .then(function (body) {
            var objects = body.objects || [];
            self._files = objects.filter(function (e) { return e.type === 'file'; });
            self._folders = objects.filter(function (e) { return e.type === 'folder'; });
            self._renderToolbar();
            self._renderContent();
            if (thenDo) thenDo();
          })
          .catch(function (e) { self._showError(e.message); });
      },

      _uploadFile: function (file, isPublic, thenDo) {
        var self = this;
        lively.identity.fileCrypto.encryptAndUpload(file, {
          visibility: isPublic ? 'public' : 'private',
          onWaiting: function () { self._setUploadStatus('Confirm passkey…'); },
        }, function (err) { thenDo(err); });
      },

      // Deletes the underlying blob so the ciphertext/plaintext bytes are
      // actually reclaimed. The envelope itself is not deletable — objects.db
      // is an append-only version log (same as worlds/postcards) — so the
      // listing entry is hidden client-side rather than removed server-side;
      // re-opening it after this will 404 on the (now-gone) blob.
      _deleteFile: function (envelope, thenDo) {
        var handle = lively.identity.did.currentUser().handle;
        var base = lively.identity.did.baseUrl();
        fetch(base + '/@' + handle + '/blobs/' + envelope.blobCid, {
          method: 'DELETE',
          credentials: 'include',
        }).then(function (res) {
          if (!res.ok) return res.json().then(function (b) {
            throw new Error(b.error || ('Delete failed: ' + res.status));
          });
          thenDo(null);
        }).catch(function (e) { thenDo(e); });
      },

      // Dispatches a listing item's delete to the right underlying op: a
      // flat file deletes its blob (see _deleteFile above); a folder member
      // is dropped from the folder's own file list (removeFileFromFolder) —
      // a real removal, not the append-only-envelope limitation flat files
      // have, since it just rewrites the folder's small member array.
      _deleteItem: function (item, thenDo) {
        if (item.kind === 'folder-member') {
          var handle = lively.identity.did.currentUser().handle;
          lively.identity.fileCrypto.removeFileFromFolder(handle, this._currentFolder.objId, item.raw.id, thenDo);
          return;
        }
        this._deleteFile(item.raw, thenDo);
      },

      // ── navigation ────────────────────────────────────────────────────────

      _openFolder: function (envelope) {
        this._currentFolder = { objId: envelope.objId, name: (envelope.state && envelope.state.name) || envelope.objId };
        this._folderItems = [];
        this._loadListing();
      },

      _closeFolder: function () {
        this._currentFolder = null;
        this._folderItems = [];
        this._loadListing();
      },

      // ── folder create/rename ─────────────────────────────────────────────

      // thenDo (optional): thenDo(objId, name) once the folder exists and the
      // listing has been refreshed — used by the "Move to…" menu's "New
      // folder…" entry to immediately target the just-created folder.
      _createFolder: function (thenDo) {
        var self = this;
        $world.prompt('New folder name:', function (name) {
          if (!name || !name.trim()) { if (thenDo) thenDo(null); return; }
          name = name.trim();
          self._setUploadStatus('Creating folder…');
          lively.identity.fileCrypto.createFolder(name, {
            onWaiting: function () { self._setUploadStatus('Confirm passkey…'); },
          }, function (err, result) {
            self._setUploadStatus('');
            if (err) {
              self._showError(err.message || 'Could not create folder');
              if (thenDo) thenDo(null);
              return;
            }
            self._loadListing(function () {
              if (thenDo) thenDo(result.objId, name);
            });
          });
        }, '');
      },

      _renameFolder: function (folderEnvelope) {
        var self = this;
        var currentName = (folderEnvelope.state && folderEnvelope.state.name) || '';
        $world.prompt('Rename folder:', function (name) {
          if (!name || !name.trim()) return;
          name = name.trim();
          var handle = lively.identity.did.currentUser().handle;
          self._setUploadStatus('Renaming…');
          lively.identity.fileCrypto.renameFolder(handle, folderEnvelope.objId, name, function (err) {
            self._setUploadStatus('');
            if (err) return self._showError(err.message || 'Could not rename folder');
            self._loadListing();
          });
        }, currentName);
      },

      // ── moving files into/out of/between folders ─────────────────────────

      // item: a normalized listing item (see _buildListItems). target:
      // { kind: 'folder', objId, name } or { kind: 'root' }.
      _performMove: function (item, target) {
        var self = this;
        function proceed() {
          self._setUploadStatus('Moving…');
          self._executeMove(item, target, function (err) {
            self._setUploadStatus('');
            if (err) return self._showError(err.message || 'Move failed');
            self._loadListing();
          });
        }
        if (item.isPublic && target.kind === 'folder') {
          $world.confirm('Moving "' + item.name + '" into a folder makes it private — its public link will stop working. Continue?', function (ok) {
            if (ok) proceed();
          });
        } else {
          proceed();
        }
      },

      _executeMove: function (item, target, thenDo) {
        var handle = lively.identity.did.currentUser().handle;
        var fc = lively.identity.fileCrypto;

        if (item.kind === 'file' && target.kind === 'folder') {
          return fc.moveFileIntoFolder(handle, item.raw, target.objId, {}, thenDo);
        }
        if (item.kind === 'folder-member' && target.kind === 'root') {
          return fc.moveFileOutOfFolder(handle, this._currentFolder.objId, item.raw, {}, thenDo);
        }
        if (item.kind === 'folder-member' && target.kind === 'folder') {
          var sourceFolderObjId = this._currentFolder.objId;
          if (target.objId === sourceFolderObjId) return thenDo(null, { noop: true });
          return fc.moveFileOutOfFolder(handle, sourceFolderObjId, item.raw, {}, function (err, outResult) {
            if (err) return thenDo(err);
            fc.moveFileIntoFolder(handle, { objId: outResult.objId, blobCid: outResult.blobCid }, target.objId, {}, thenDo);
          });
        }
        thenDo(new Error('Unsupported move'));
      },

      // ── drag and drop (file/member cards -> folder cards or the "back" crumb) ──

      _makeDraggable: function (el, item) {
        var self = this;
        el.draggable = true;
        el.addEventListener('dragstart', function (e) {
          self._dragPayload = { kind: item.kind, item: item };
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', item.name); } catch (ignored) {}
        });
        el.addEventListener('dragend', function () { self._dragPayload = null; });
      },

      // Tags a folder card/tile as a drop target — see the 'html5 drag and
      // drop' section below for why this is a plain data-attribute rather
      // than dragover/drop addEventListener calls on the element itself.
      _makeDropTarget: function (el, folderEnvelope) {
        el.setAttribute('data-folder-id', folderEnvelope.objId);
        el.setAttribute('data-folder-name', (folderEnvelope.state && folderEnvelope.state.name) || folderEnvelope.objId);
      },

      // The breadcrumb's "Your files" segment, while inside a folder, is
      // also a drop target for moving a member back out to the root.
      _makeBackDropTarget: function (el) {
        el.setAttribute('data-back-target', '1');
      },

      // ── toolbar ───────────────────────────────────────────────────────────

      _renderToolbar: function () {
        var self = this;
        var bar = this._toolbarDiv;
        bar.innerHTML = '';
        bar.className = 'fls-toolbar';

        var row1 = document.createElement('div');
        row1.className = 'fls-toolbar-row';

        var crumb = document.createElement('span');
        crumb.className = 'fls-breadcrumb';
        var rootSeg = document.createElement('span');
        rootSeg.textContent = 'Your files';
        if (this._currentFolder) {
          rootSeg.className = 'fls-crumb-link';
          rootSeg.addEventListener('click', function () { self._closeFolder(); });
          this._makeBackDropTarget(rootSeg);
        }
        crumb.appendChild(rootSeg);
        if (this._currentFolder) {
          var sep = document.createElement('span');
          sep.className = 'fls-crumb-sep';
          sep.textContent = 'chevron_right';
          crumb.appendChild(sep);
          var folderSeg = document.createElement('span');
          folderSeg.textContent = this._currentFolder.name;
          crumb.appendChild(folderSeg);
        }
        row1.appendChild(crumb);

        var statusSpan = document.createElement('span');
        statusSpan.className = 'fls-status';
        row1.appendChild(statusSpan);
        this._uploadStatusSpan = statusSpan;

        var publicToggle = document.createElement('label');
        publicToggle.className = 'fls-toggle';
        var publicCheckbox = document.createElement('input');
        publicCheckbox.type = 'checkbox';
        publicToggle.appendChild(publicCheckbox);
        publicToggle.appendChild(document.createTextNode('Public'));
        // Folders can never contain a public member (Encryption.md §15) —
        // hide the toggle rather than let it silently do nothing.
        if (this._currentFolder) publicToggle.style.display = 'none';
        row1.appendChild(publicToggle);

        var uploadBtn = this._makeToolbarBtn('upload', 'Upload', 'accent');
        var fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', function () {
          var f = fileInput.files[0];
          fileInput.value = '';
          if (!f) return;
          uploadBtn.disabled = true;
          self._setUploadStatus('Encrypting…');
          function done(err) {
            uploadBtn.disabled = false;
            self._setUploadStatus('');
            if (err) return self._showError(err.message);
            self._loadListing();
          }
          if (self._currentFolder) {
            var handle = lively.identity.did.currentUser().handle;
            lively.identity.fileCrypto.addFileToFolder(handle, self._currentFolder.objId, f, {}, done);
          } else {
            self._uploadFile(f, publicCheckbox.checked, done);
          }
        });
        uploadBtn.addEventListener('click', function () { fileInput.click(); });
        row1.appendChild(uploadBtn);
        row1.appendChild(fileInput);

        var dropBtn = this._makeToolbarBtn('bolt', 'Drop', 'plain');
        dropBtn.addEventListener('click', function () {
          lively.require('lively.identity.WarpDrop').toRun(function () {
            lively.identity.WarpDrop.open();
          });
        });
        row1.appendChild(dropBtn);

        bar.appendChild(row1);

        var row2 = document.createElement('div');
        row2.className = 'fls-toolbar-row fls-toolbar-row-secondary';

        var newFolderBtn = this._makeToolbarBtn('create_new_folder', 'New Folder', 'plain');
        newFolderBtn.addEventListener('click', function () { self._createFolder(); });
        row2.appendChild(newFolderBtn);

        var sortSelect = document.createElement('select');
        sortSelect.className = 'fls-select';
        [['date', 'Date'], ['name', 'Name'], ['type', 'Type'], ['size', 'Size']].forEach(function (pair) {
          var opt = document.createElement('option');
          opt.value = pair[0];
          opt.textContent = pair[1];
          if (pair[0] === self._sortBy) opt.selected = true;
          sortSelect.appendChild(opt);
        });
        sortSelect.addEventListener('change', function () {
          self._sortBy = sortSelect.value;
          self._renderContent();
        });
        row2.appendChild(sortSelect);

        var dirBtn = this._makeIconBtn(this._sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward', 'Sort direction');
        dirBtn.addEventListener('click', function () {
          self._sortDir = self._sortDir === 'asc' ? 'desc' : 'asc';
          self._renderToolbar();
          self._renderContent();
        });
        row2.appendChild(dirBtn);

        var groupToggle = document.createElement('label');
        groupToggle.className = 'fls-toggle';
        var groupCheckbox = document.createElement('input');
        groupCheckbox.type = 'checkbox';
        groupCheckbox.checked = this._groupByType;
        groupCheckbox.addEventListener('change', function () {
          self._groupByType = groupCheckbox.checked;
          self._renderContent();
        });
        groupToggle.appendChild(groupCheckbox);
        groupToggle.appendChild(document.createTextNode('Group by type'));
        row2.appendChild(groupToggle);

        var spacer = document.createElement('span');
        spacer.style.flex = '1';
        row2.appendChild(spacer);

        var viewToggle = document.createElement('div');
        viewToggle.className = 'fls-view-toggle';
        var listBtn = this._makeIconBtn('view_list', 'List view');
        var gridBtn = this._makeIconBtn('grid_view', 'Grid view');
        listBtn.classList.toggle('fls-btn-accent', this._viewMode === 'list');
        gridBtn.classList.toggle('fls-btn-accent', this._viewMode === 'grid');
        listBtn.addEventListener('click', function () { self._viewMode = 'list'; self._renderToolbar(); self._renderContent(); });
        gridBtn.addEventListener('click', function () { self._viewMode = 'grid'; self._renderToolbar(); self._renderContent(); });
        viewToggle.appendChild(listBtn);
        viewToggle.appendChild(gridBtn);
        row2.appendChild(viewToggle);

        bar.appendChild(row2);
      },

      _setUploadStatus: function (msg) {
        if (this._uploadStatusSpan) this._uploadStatusSpan.textContent = msg;
      },

      // variant: 'accent' or 'plain' (matching pcm-btn-* naming elsewhere
      // in this codebase — see PostCardMailbox.js's _makeIconTextButton).
      _makeToolbarBtn: function (glyph, label, variant) {
        var btn = document.createElement('button');
        btn.className = 'fls-btn' + (variant === 'accent' ? ' fls-btn-accent' : '');
        var icon = document.createElement('span');
        icon.className = 'fls-btn-icon-glyph';
        icon.textContent = glyph;
        btn.appendChild(icon);
        btn.appendChild(document.createTextNode(label));
        return btn;
      },

      _makeIconBtn: function (glyph, title) {
        var btn = document.createElement('button');
        btn.className = 'fls-btn fls-btn-icon-only';
        btn.title = title;
        var icon = document.createElement('span');
        icon.className = 'fls-btn-icon-glyph';
        icon.textContent = glyph;
        btn.appendChild(icon);
        return btn;
      },

      // ── listing: normalize -> group -> sort -> render ────────────────────

      // Produces one flat array of normalized items for whatever's currently
      // in view (root: folders + files; inside a folder: its members), so
      // sorting/grouping/rendering only has to be written once.
      _buildListItems: function () {
        var self = this;
        var items = [];

        if (this._currentFolder) {
          this._folderItems.forEach(function (entry) {
            items.push({
              kind: 'folder-member',
              name: entry.name,
              ext: self._extOf(entry.name),
              size: typeof entry.size === 'number' ? entry.size : null,
              sizeKnown: typeof entry.size === 'number',
              created: entry.addedAt,
              isPublic: false,
              raw: entry,
            });
          });
          return items;
        }

        this._folders.forEach(function (envelope) {
          var name = (envelope.state && envelope.state.name) || envelope.objId;
          var fileCount = (envelope.state && envelope.state.fileCount) || 0;
          items.push({
            kind: 'folder',
            name: name,
            ext: '',
            size: fileCount,
            sizeKnown: true,
            created: envelope.created,
            isPublic: false,
            raw: envelope,
          });
        });
        this._files.forEach(function (envelope) {
          var name = (envelope.state && envelope.state.name) || envelope.objId;
          var payloadSize = envelope.record && envelope.record.payload && typeof envelope.record.payload.size === 'number'
            ? envelope.record.payload.size : null;
          var cachedSize = self._sizeCache[envelope.objId];
          var size = payloadSize !== null ? payloadSize : (typeof cachedSize === 'number' ? cachedSize : null);
          items.push({
            kind: 'file',
            name: name,
            ext: self._extOf(name),
            size: size,
            sizeKnown: size !== null,
            created: envelope.created,
            isPublic: envelope.visibility === 'public',
            raw: envelope,
          });
        });
        return items;
      },

      // Decrypts the small metadata payload (no blob fetch) for any listed
      // file whose size isn't already known, but only when the user has
      // actually picked "Sort by size" — never on a normal window open, per
      // the design decision that this can trigger a passkey prompt.
      _ensureSizesForSort: function (items, thenDo) {
        var self = this;
        if (this._sortBy !== 'size') return thenDo();
        var missing = items.filter(function (it) { return it.kind === 'file' && !it.sizeKnown; });
        if (!missing.length) return thenDo();

        this._setUploadStatus('Decrypting sizes…');
        var remaining = missing.length;
        missing.forEach(function (it) {
          lively.identity.fileCrypto.decryptFileEnvelopeMetadata(it.raw, function (err, metadata) {
            if (err) {
              console.warn('[FilesBrowser] could not decrypt size for', it.name, err.message);
            } else if (metadata && typeof metadata.size === 'number') {
              self._sizeCache[it.raw.objId] = metadata.size;
              it.size = metadata.size;
              it.sizeKnown = true;
            }
            if (--remaining === 0) {
              self._setUploadStatus('');
              thenDo();
            }
          });
        });
      },

      // Folders always sort ahead of files/members (classic file-manager
      // convention), each bucket internally ordered by the active sort.
      _sortItems: function (items) {
        var self = this;
        var dir = this._sortDir === 'desc' ? -1 : 1;
        function cmpStr(a, b) { return (a || '').localeCompare(b || '', undefined, { sensitivity: 'base' }); }
        function compare(a, b) {
          switch (self._sortBy) {
            case 'name': return cmpStr(a.name, b.name) * dir;
            case 'type': {
              var av = a.kind === 'folder' ? '' : a.ext;
              var bv = b.kind === 'folder' ? '' : b.ext;
              var c = cmpStr(av, bv);
              return (c !== 0 ? c : cmpStr(a.name, b.name)) * dir;
            }
            case 'size': {
              var as = typeof a.size === 'number' ? a.size : -1;
              var bs = typeof b.size === 'number' ? b.size : -1;
              return (as - bs) * dir;
            }
            case 'date':
            default:
              return cmpStr(a.created, b.created) * dir;
          }
        }
        var folders = items.filter(function (i) { return i.kind === 'folder'; }).sort(compare);
        var rest = items.filter(function (i) { return i.kind !== 'folder'; }).sort(compare);
        return folders.concat(rest);
      },

      // Returns [{ label: string|null, items: [...] }, ...]. With grouping
      // off, one section with no header. With grouping on: a "Folders"
      // section (if any), then one section per file family that has members.
      _groupItems: function (items) {
        var sorted = this._sortItems(items);
        if (!this._groupByType) return [{ label: null, items: sorted }];

        var folders = sorted.filter(function (i) { return i.kind === 'folder'; });
        var rest = sorted.filter(function (i) { return i.kind !== 'folder'; });
        var sections = [];
        if (folders.length) sections.push({ label: 'Folders (' + folders.length + ')', items: folders });
        FAMILIES.forEach(function (fam) {
          var bucket = rest.filter(function (i) { return familyFor(i.ext).key === fam.key; });
          if (bucket.length) sections.push({ label: fam.label + ' (' + bucket.length + ')', items: bucket });
        });
        return sections;
      },

      _renderContent: function () {
        var self = this;
        var items = this._buildListItems();
        this._ensureSizesForSort(items, function () { self._renderItems(items); });
      },

      _renderItems: function (items) {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        if (!items.length) {
          content.innerHTML = this._emptyHtml('folder_open', this._currentFolder ? 'This folder is empty.' : 'No files yet.');
          return;
        }

        var sections = this._groupItems(items);
        sections.forEach(function (section) {
          if (section.label) content.appendChild(self._renderGroupHeader(section.label));
          var wrap = self._viewMode === 'grid' ? self._makeGridEl() : content;
          if (self._viewMode === 'grid') content.appendChild(wrap);
          section.items.forEach(function (item) {
            var el = self._viewMode === 'grid' ? self._renderGridItem(item) : self._renderListItem(item);
            wrap.appendChild(el);
          });
        });
      },

      _renderGroupHeader: function (label) {
        var h = document.createElement('div');
        h.className = 'fls-group-header';
        h.textContent = label;
        return h;
      },

      _makeGridEl: function () {
        var grid = document.createElement('div');
        grid.className = 'fls-grid';
        return grid;
      },

      // ── list-mode item rendering ──────────────────────────────────────────

      _renderListItem: function (item) {
        var self = this;
        var isFolder = item.kind === 'folder';
        var card = this._makeCard();

        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:flex-start;gap:10px;' +
          'padding-right:' + (isFolder ? '96px' : '176px') + ';' +
          (isFolder ? 'cursor:pointer;' : '');

        var handle = lively.identity.did.currentUser().handle;
        var base = lively.identity.did.baseUrl();

        if (!isFolder && IMAGE_EXTS.indexOf(item.ext) !== -1 && item.isPublic) {
          var thumb = document.createElement('img');
          var meta = item.raw.record && item.raw.record.payload;
          thumb.src = base + '/@' + handle + '/blobs/' + (meta && meta.blobCid);
          thumb.className = 'fls-file-thumb';
          row.appendChild(thumb);
        } else {
          var icon = document.createElement('div');
          icon.className = 'fls-file-icon';
          icon.textContent = isFolder ? 'folder' : self._iconFor(item.ext);
          row.appendChild(icon);
        }

        var info = document.createElement('div');
        info.style.cssText = 'min-width:0;';
        var nameDiv = document.createElement('div');
        nameDiv.style.cssText = 'font-weight:600;color:var(--fls-text);word-break:break-all;margin-bottom:3px;';
        nameDiv.textContent = item.name;
        info.appendChild(nameDiv);

        if (!isFolder) {
          var badge = document.createElement('span');
          badge.className = 'fls-badge ' + (item.isPublic ? 'fls-badge-public' : 'fls-badge-private');
          var badgeIcon = document.createElement('span');
          badgeIcon.className = 'fls-badge-icon';
          badgeIcon.textContent = item.isPublic ? 'public' : 'lock';
          badge.appendChild(badgeIcon);
          badge.appendChild(document.createTextNode(item.isPublic ? 'Public' : 'Private'));
          info.appendChild(badge);
        }

        var metaDiv = document.createElement('div');
        metaDiv.style.cssText = 'color:var(--fls-text-tertiary);font-size:11px;margin-top:3px;';
        var sizeText = isFolder
          ? (item.size === 1 ? '1 file' : item.size + ' files')
          : (item.sizeKnown ? self._formatSize(item.size) : 'encrypted');
        metaDiv.textContent = sizeText + ' · ' + self._formatDate(item.created);
        info.appendChild(metaDiv);
        row.appendChild(info);
        card.appendChild(row);

        if (isFolder) {
          row.addEventListener('click', function () { self._openFolder(item.raw); });
          self._makeDropTarget(card, item.raw);
        } else {
          self._makeDraggable(card, item);
        }

        var actions = document.createElement('div');
        actions.style.cssText = 'position:absolute;top:12px;right:14px;display:flex;gap:6px;align-items:center;';

        if (isFolder) {
          var renameBtn = document.createElement('button');
          renameBtn.textContent = 'Rename';
          renameBtn.className = 'fls-btn';
          renameBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            self._renameFolder(item.raw);
          });
          actions.appendChild(renameBtn);
        } else {
          var openBtn = document.createElement('button');
          openBtn.textContent = 'Open';
          openBtn.className = 'fls-btn fls-btn-accent';
          openBtn.addEventListener('click', function () { self._openItem(item); });
          actions.appendChild(openBtn);

          var moveBtn = self._makeIconBtn('drive_file_move', 'Move to…');
          moveBtn.addEventListener('click', function () { self._showMoveMenu(moveBtn, item); });
          actions.appendChild(moveBtn);

          var deleteBtn = document.createElement('button');
          deleteBtn.textContent = 'Delete';
          deleteBtn.className = 'fls-btn fls-btn-ghost-danger';
          deleteBtn.addEventListener('click', function () {
            $world.confirm('Delete ' + item.name + '?', function (ok) {
              if (!ok) return;
              deleteBtn.disabled = true;
              self._deleteItem(item, function (err) {
                deleteBtn.disabled = false;
                if (err) return self._showError(err.message || 'Failed to delete');
                self._loadListing();
              });
            });
          });
          actions.appendChild(deleteBtn);
        }

        card.appendChild(actions);
        return card;
      },

      // ── grid-mode item rendering ──────────────────────────────────────────

      _renderGridItem: function (item) {
        var self = this;
        var isFolder = item.kind === 'folder';
        var tile = document.createElement('div');
        tile.className = 'fls-tile';

        var iconWrap = document.createElement('div');
        iconWrap.className = 'fls-tile-icon';
        var handle = lively.identity.did.currentUser().handle;
        var base = lively.identity.did.baseUrl();
        if (!isFolder && IMAGE_EXTS.indexOf(item.ext) !== -1 && item.isPublic) {
          var thumb = document.createElement('img');
          var meta = item.raw.record && item.raw.record.payload;
          thumb.src = base + '/@' + handle + '/blobs/' + (meta && meta.blobCid);
          thumb.className = 'fls-tile-thumb';
          iconWrap.appendChild(thumb);
        } else {
          iconWrap.textContent = isFolder ? 'folder' : self._iconFor(item.ext);
        }
        tile.appendChild(iconWrap);

        var nameDiv = document.createElement('div');
        nameDiv.className = 'fls-tile-name';
        nameDiv.textContent = item.name;
        nameDiv.title = item.name;
        tile.appendChild(nameDiv);

        var menuBtn = self._makeIconBtn('more_vert', 'Actions');
        menuBtn.classList.add('fls-tile-menu');
        menuBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          self._showTileMenu(menuBtn, item);
        });
        tile.appendChild(menuBtn);

        if (isFolder) {
          tile.addEventListener('click', function () { self._openFolder(item.raw); });
          self._makeDropTarget(tile, item.raw);
        } else {
          tile.addEventListener('dblclick', function () { self._openItem(item); });
          self._makeDraggable(tile, item);
        }

        return tile;
      },

      // ── popup menus ("Move to…" folder picker, grid-tile kebab menu) ─────

      _buildPopup: function (anchorEl, entries) {
        var rect = anchorEl.getBoundingClientRect();
        var popup = document.createElement('div');
        popup.className = 'fls-popup';
        popup.style.left = rect.left + 'px';
        popup.style.top = (rect.bottom + 4) + 'px';

        function closePopup() {
          if (popup.parentNode) popup.parentNode.removeChild(popup);
          document.removeEventListener('mousedown', onOutside, true);
        }
        function onOutside(e) {
          if (!popup.contains(e.target)) closePopup();
        }

        entries.forEach(function (entry) {
          if (entry.separator) {
            var sep = document.createElement('div');
            sep.className = 'fls-popup-sep';
            popup.appendChild(sep);
            return;
          }
          var row = document.createElement('div');
          row.className = 'fls-popup-item' + (entry.danger ? ' danger' : '');
          if (entry.glyph) {
            var icon = document.createElement('span');
            icon.className = 'fls-popup-icon';
            icon.textContent = entry.glyph;
            row.appendChild(icon);
          }
          row.appendChild(document.createTextNode(entry.label));
          row.addEventListener('click', function (e) {
            e.stopPropagation();
            closePopup();
            entry.onClick();
          });
          popup.appendChild(row);
        });

        document.body.appendChild(popup);
        // Deferred so the same click that opened this popup (still bubbling
        // up to document) doesn't immediately trigger onOutside and close it.
        setTimeout(function () { document.addEventListener('mousedown', onOutside, true); }, 0);
        return { close: closePopup };
      },

      // Folder-picker popup for moving `item` — lists every top-level folder
      // (minus the one it's already in, if any), a "Back to Files" entry
      // when moving a folder member, and "New folder…".
      _showMoveMenu: function (anchorEl, item) {
        var self = this;
        var entries = [];
        this._folders.forEach(function (f) {
          if (self._currentFolder && f.objId === self._currentFolder.objId) return;
          var name = (f.state && f.state.name) || f.objId;
          entries.push({
            label: name,
            glyph: 'folder',
            onClick: function () { self._performMove(item, { kind: 'folder', objId: f.objId, name: name }); },
          });
        });
        if (this._currentFolder && item.kind === 'folder-member') {
          entries.push({ label: 'Back to Files', glyph: 'undo', onClick: function () { self._performMove(item, { kind: 'root' }); } });
        }
        entries.push({ separator: true });
        entries.push({
          label: 'New folder…',
          glyph: 'create_new_folder',
          onClick: function () {
            self._createFolder(function (folderObjId) {
              if (folderObjId) self._performMove(item, { kind: 'folder', objId: folderObjId });
            });
          },
        });
        this._buildPopup(anchorEl, entries);
      },

      // Grid-mode kebab menu: Open / Move to… / Delete for a file or member;
      // Open / Rename for a folder (no delete — see the class doc comment).
      _showTileMenu: function (anchorEl, item) {
        var self = this;
        var entries = [];
        if (item.kind === 'folder') {
          entries.push({ label: 'Open', glyph: 'folder_open', onClick: function () { self._openFolder(item.raw); } });
          entries.push({ label: 'Rename', glyph: 'edit', onClick: function () { self._renameFolder(item.raw); } });
        } else {
          entries.push({ label: 'Open', glyph: 'open_in_new', onClick: function () { self._openItem(item); } });
          entries.push({ label: 'Move to…', glyph: 'drive_file_move', onClick: function () { self._showMoveMenu(anchorEl, item); } });
          entries.push({ separator: true });
          entries.push({
            label: 'Delete', glyph: 'delete', danger: true,
            onClick: function () {
              $world.confirm('Delete ' + item.name + '?', function (ok) {
                if (!ok) return;
                self._deleteItem(item, function (err) {
                  if (err) return self._showError(err.message || 'Failed to delete');
                  self._loadListing();
                });
              });
            },
          });
        }
        this._buildPopup(anchorEl, entries);
      },

      // ── opening a file/member ─────────────────────────────────────────────

      _openItem: function (item) {
        var self = this;
        var handle = lively.identity.did.currentUser().handle;

        function withUrl(cb) {
          if (item.kind === 'folder-member') {
            lively.identity.fileCrypto.folderFileUrl(handle, self._currentFolder.objId, item.raw, cb);
          } else {
            lively.identity.fileCrypto.objectUrlFor(handle, item.raw.objId, cb);
          }
        }

        withUrl(function (err, url) {
          if (err) return self._showError('Could not open file: ' + err.message);
          if (PREVIEWABLE_EXTS.indexOf(item.ext) !== -1) {
            lively.require('lively.identity.FilePreview').toRun(function () {
              lively.identity.FilePreview.open({ path: item.name, url: url });
            });
          } else {
            window.open(url, '_blank');
          }
        });
      },

      // ── helpers ───────────────────────────────────────────────────────────

      _makeCard: function () {
        var card = document.createElement('div');
        card.className = 'fls-card';
        return card;
      },

      _extOf: function (p) {
        var m = /\.([a-z0-9]+)$/i.exec(p || '');
        return m ? m[1].toLowerCase() : '';
      },

      // Material Symbols Rounded glyph for a non-image/non-thumbnailed
      // file's icon tile, grouped by rough file family (see FAMILIES above).
      _iconFor: function (ext) {
        return familyFor(ext).icon;
      },

      _formatSize: function (bytes) {
        if (typeof bytes !== 'number') return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      },

      _formatDate: function (iso) {
        if (!iso) return '';
        try {
          var d = new Date(iso);
          return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (e) { return iso; }
      },

      _showError: function (msg) {
        this._contentDiv.innerHTML = this._emptyHtml('error', msg, true);
      },

    },

    'html5 drag and drop', {

      // A plain card.addEventListener('dragover'/'drop', ...) never fires
      // here: lively.morphic.World registers its own capture-phase
      // 'dragover'/'drop' listeners on its own (ancestor) shapeNode
      // (Events.js registerForPointerEvents/registerForMouseEvents, used
      // for OS-file-drag-into-world uploads), and its onHTML5DragOver/
      // onHTML5Drop handlers call evt.stop() (real stopPropagation +
      // preventDefault) before the event ever reaches a nested morph's own
      // raw-DOM listeners — confirmed live 2026-09-24 via a direct
      // dispatchEvent() test: dragstart fired (registered separately, on
      // `document`, bubble-phase, unaffected), but dragover/drop on the
      // card itself never did. The World's own handlers DO delegate to
      // `targetM.onHTML5Drag`/`targetM.onHTML5Drop` first, when the target
      // morph under the cursor (morphsContainingPoint(...).first(), which
      // resolves to the innermost morph — this Box itself, not the
      // enclosing classic Window) defines them — hence these two methods,
      // which do their own plain-DOM hit-testing (document.elementFromPoint)
      // against the data-folder-id/data-back-target attributes _makeDropTarget/
      // _makeBackDropTarget tag onto cards, rather than relying on
      // per-element dragover/drop listeners at all.
      onHTML5Drag: function (evt) {
        if (!this._dragPayload) return false;
        var target = this._dropTargetAt(evt.clientX, evt.clientY);
        if (this._dragHoverEl && (!target || this._dragHoverEl !== target.el)) {
          this._dragHoverEl.classList.remove('dragover');
          this._dragHoverEl = null;
        }
        if (!target) return false;
        evt.preventDefault();
        target.el.classList.add('dragover');
        this._dragHoverEl = target.el;
        return true;
      },

      onHTML5Drop: function (evt) {
        var target = this._dropTargetAt(evt.clientX, evt.clientY);
        if (this._dragHoverEl) { this._dragHoverEl.classList.remove('dragover'); this._dragHoverEl = null; }
        var payload = this._dragPayload;
        this._dragPayload = null;
        if (!target || !payload) return false;
        evt.preventDefault();
        this._performMove(payload.item, target.spec);
        return true;
      },

      // (x, y): viewport/client coordinates, matching a native DragEvent's
      // own clientX/clientY — document.elementFromPoint needs no further
      // coordinate translation despite this being called from a Lively
      // morph event handler. Returns { el, spec } or null.
      _dropTargetAt: function (x, y) {
        var el = document.elementFromPoint(x, y);
        if (!el || !el.closest) return null;
        var payload = this._dragPayload;
        if (!payload) return null;

        var folderEl = el.closest('[data-folder-id]');
        if (folderEl && payload.kind !== 'folder') {
          return {
            el: folderEl,
            spec: { kind: 'folder', objId: folderEl.getAttribute('data-folder-id'), name: folderEl.getAttribute('data-folder-name') },
          };
        }
        var backEl = el.closest('[data-back-target]');
        if (backEl && payload.kind === 'folder-member') {
          return { el: backEl, spec: { kind: 'root' } };
        }
        return null;
      },

    }); // end subclass

    // ── class-side entry point ───────────────────────────────────────────────

    Object.extend(FilesBrowserClass, {
      // Opens a file envelope from the home listing the way the Files window's own
      // Open does: an in-world preview for previewable types, a new tab otherwise.
      // Used by the search palette. thenDo(err) is optional.
      openFileEnvelope: function (envelope, thenDo) {
        var handle = lively.identity.did.currentUser().handle,
          name = (envelope.state && envelope.state.name) || envelope.objId,
          m = /\.([a-z0-9]+)$/i.exec(name),
          ext = m ? m[1].toLowerCase() : '';
        lively.identity.fileCrypto.objectUrlFor(handle, envelope.objId, function (err, url) {
          if (err) { if (thenDo) thenDo(err); return; }
          if (PREVIEWABLE_EXTS.indexOf(ext) !== -1) lively.identity.FilePreview.open({ path: name, url: url });
          else window.open(url, '_blank');
          if (thenDo) thenDo(null);
        });
      },

      // Opens the Files window already inside the given folder envelope.
      openFolderEnvelope: function (envelope) {
        var browser = FilesBrowserClass.open();
        browser._openFolder(envelope);
        return browser;
      },

      open: function () {
        // 520px wide — the toolbar's pill buttons + "Public" toggle need a
        // bit more room than the old plain-text buttons did.
        var morph = new lively.identity.FilesBrowser(lively.rect(0, 0, 520, 460));
        morph.setName('Files');
        // Real classic Window chrome (drag/resize/collapse/close, Material
        // Symbols icon controls by default) rather than the hand-rolled
        // title bar this used to draw itself — same pattern as
        // CalendarApp.js's CalendarAppClass.open.
        morph.openInWindow({
          title: 'Files',
          pos: lively.morphic.World.current().visibleBounds().center().subPt(lively.pt(260, 230)),
        });
        var win = morph.getWindow();
        _ensureAccentChromeCss();
        win.addStyleClassName('files-accent-chrome');
        win.comeForward();
        return morph;
      },
    });

  }); // end module('lively.identity.FilesBrowser')
