/**
 * lively.identity.FilePreview
 *
 * In-world viewer for a single uploaded file, opened from FilesBrowser
 * instead of leaving the world via window.open(). Supports images, text,
 * audio, and video; FilesBrowser falls back to window.open() itself for
 * any other type, so this morph only ever needs to handle those four.
 *
 * Entry point:
 *   lively.identity.FilePreview.open(file)
 *     file: {path, url, size, mtime} — the entry shape FilesBrowser gets
 *     back from GET /@:handle/uploads.
 */

module('lively.identity.FilePreview')
  .requires()
  .toRun(function () {

    var IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
    var TEXT_EXTS  = ['txt', 'json', 'md', 'js', 'css', 'html', 'csv', 'log'];
    var AUDIO_EXTS = ['mp3', 'wav', 'ogg'];
    var VIDEO_EXTS = ['mp4', 'webm', 'mov'];

    var PreviewClass = lively.morphic.Box.subclass('lively.identity.FilePreview',

    'serialization', {
      doNotSerialize: ['_contentDiv'],
    },

    'initialization', {

      initialize: function ($super, bounds) {
        $super(bounds);
        this._contentDiv = null;
        this._buildChrome();
      },

      _buildChrome: function () {
        var self = this;
        this.setFill(Color.white);
        this.setDroppingEnabled(false);
        var shapeNode = this.renderContext().shapeNode;
        shapeNode.style.borderRadius = '8px';
        shapeNode.style.boxShadow    = '0 4px 16px rgba(0,0,0,0.18)';

        var titleBar = document.createElement('div');
        titleBar.style.cssText = [
          'position:absolute', 'top:0', 'left:0', 'right:0', 'height:36px',
          'background:#2c2c2e', 'border-radius:8px 8px 0 0',
          'display:flex', 'align-items:center', 'justify-content:space-between',
          'padding:0 12px', 'box-sizing:border-box',
        ].join(';');
        var titleText = document.createElement('span');
        titleText.style.cssText = [
          'color:#fff', 'font-size:13px', 'font-weight:600',
          'font-family:sans-serif', 'overflow:hidden', 'flex:1', 'min-width:0',
          'text-overflow:ellipsis', 'white-space:nowrap',
        ].join(';');
        titleBar.appendChild(titleText);
        var closeBtn = this._makeCloseButton(function () { self.remove(); });
        titleBar.appendChild(closeBtn);
        shapeNode.appendChild(titleBar);
        this._titleText = titleText;

        var contentDiv = document.createElement('div');
        contentDiv.style.cssText = [
          'position:absolute', 'top:36px', 'left:0', 'right:0', 'bottom:0',
          'overflow:auto', 'box-sizing:border-box',
          'display:flex', 'align-items:center', 'justify-content:center',
        ].join(';');
        shapeNode.appendChild(contentDiv);
        this._contentDiv = contentDiv;
      },

      // "x" close button for the black title bar -- this window has no
      // standard Lively Window chrome (it's a bare Box positioned via
      // openInWorldCenter), so without this there is no way to dismiss it
      // short of the morph halo.
      _makeCloseButton: function (onClick) {
        var btn = document.createElement('span');
        btn.textContent = '✕';
        btn.title = 'Close';
        btn.style.cssText = [
          'color:#fff', 'font-size:13px', 'line-height:1', 'cursor:pointer',
          'padding:3px 6px', 'border-radius:3px', 'flex-shrink:0',
        ].join(';');
        btn.addEventListener('mouseenter', function () { btn.style.background = 'rgba(255,255,255,0.15)'; });
        btn.addEventListener('mouseleave', function () { btn.style.background = 'transparent'; });
        btn.addEventListener('click', onClick);
        return btn;
      },

      _extOf: function (p) {
        var m = /\.([a-z0-9]+)$/i.exec(p || '');
        return m ? m[1].toLowerCase() : '';
      },

      showFile: function (file) {
        this._titleText.textContent = file.path;
        var content = this._contentDiv;
        content.innerHTML = '';
        var ext = this._extOf(file.path);

        if (IMAGE_EXTS.indexOf(ext) !== -1) {
          var img = document.createElement('img');
          img.src = file.url;
          img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
          content.appendChild(img);
        } else if (AUDIO_EXTS.indexOf(ext) !== -1) {
          var audio = document.createElement('audio');
          audio.controls = true;
          audio.src = file.url;
          audio.style.width = '90%';
          content.appendChild(audio);
        } else if (VIDEO_EXTS.indexOf(ext) !== -1) {
          var video = document.createElement('video');
          video.controls = true;
          video.src = file.url;
          video.style.cssText = 'max-width:100%;max-height:100%;';
          content.appendChild(video);
        } else if (TEXT_EXTS.indexOf(ext) !== -1) {
          content.style.display = 'block';
          content.style.padding = '12px';
          var pre = document.createElement('pre');
          pre.style.cssText = [
            'margin:0', 'font-family:monospace', 'font-size:12px',
            'white-space:pre-wrap', 'word-break:break-word',
          ].join(';');
          pre.textContent = 'Loading…';
          content.appendChild(pre);
          fetch(file.url, { credentials: 'include' })
            .then(function (r) { return r.text(); })
            .then(function (text) { pre.textContent = text; })
            .catch(function (e) { pre.textContent = 'Failed to load: ' + e.message; });
        } else {
          var msg = document.createElement('div');
          msg.style.cssText = 'color:#999;font-family:sans-serif;font-size:13px;';
          msg.textContent = 'No in-world preview for this file type.';
          content.appendChild(msg);
        }
      },

    }); // end subclass

    // ── class-side entry point ───────────────────────────────────────────────

    Object.extend(PreviewClass, {
      open: function (file) {
        var morph = new lively.identity.FilePreview(lively.rect(0, 0, 520, 420));
        morph.openInWorldCenter();
        morph.bringToFront();
        morph.showFile(file);
        return morph;
      },
    });

  }); // end module('lively.identity.FilePreview')
