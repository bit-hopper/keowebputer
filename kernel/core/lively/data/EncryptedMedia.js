/**
 * lively.data.EncryptedMedia
 *
 * Renders private/encrypted file content (uploaded via
 * lively.data.FileUpload.identityUpload, which defaults to
 * visibility:'private') through Image/Video/PDF morphs. A plain
 * <img src>/<video src>/pdfjsLib.getDocument(url) binding can never work
 * for encrypted content -- the bytes at that URL are ciphertext, and
 * decrypting needs an explicit KEK/DEK ceremony no such binding performs.
 * Confirmed live: defaulting identityUpload to private without this module
 * broke a real, previously-working image (ciphertext served straight to
 * an <img> tag, for the owner too, not just anonymous visitors).
 *
 * Mirrors the pattern already proven for postcard attachments
 * (PostCardEditor.js's _attachmentImageNodeView / FileCrypto.js's
 * resolveAttachmentUrl): only a stable reference (fileHandle/fileObjId) is
 * ever persisted; the actual displayable blob: URL is always resolved
 * fresh, asynchronously, session-local, and swapped in via direct
 * mutation of already-live DOM/morph state -- never via a persisted
 * property holding the resolved URL itself.
 *
 * Additive-subclass design: ordinary lively.morphic.Image / plain
 * lively.morphic.Shapes.External morphs (avatars, decorative images,
 * legacy plain-URL video/PDF embeds) are completely untouched by this
 * file -- only content constructed through the identity-upload path ever
 * becomes one of these Encrypted* classes.
 *
 * Post-restore lifecycle: a saved world's morphs are plain JS-graph
 * reconstructions with no live rendering yet. lively.persistence.
 * Serializer's RestoreObjectsPlugin calls onrestore() once on every
 * deserialized object exposing one, after the whole graph is rebuilt
 * (core/lively/persistence/Serializer.js). Real precedent for using it to
 * kick off async post-restore work: core/lively/jenga3d/SolidMorph.js.
 * whenOpenedInWorld (core/lively/morphic/Rendering.js) further defers
 * until the morph is actually mounted in a live, rendering world.
 */

module('lively.data.EncryptedMedia')
  .requires(
    'lively.data.FileUpload',
    'lively.data.VideoUpload',
    'lively.data.PDFUpload',
    'lively.identity.FileCrypto',
    'lively.identity.DID',
  )
  .toRun(function () {

    // ─── Image ─────────────────────────────────────────────────────────────

    lively.morphic.Shapes.Image.subclass('lively.morphic.Shapes.EncryptedImage', {
      // The live _ImageURL is always a session-local blob: URL, re-resolved
      // fresh on every load/restore -- never meaningful to persist, and
      // persisting it would silently leak a dead blob: reference into every
      // save. fileHandle/fileObjId (plain, non-excluded properties below)
      // are the real, stable, persisted reference.
      doNotSerialize: ['_ImageURL'],
    });

    lively.morphic.Image.subclass('lively.data.FileUpload.EncryptedImage', {
      defaultShape: function (bounds, url) {
        return new lively.morphic.Shapes.EncryptedImage(bounds, url || '');
      },

      // fileRef: {handle, objId}. Deliberately does NOT forward a load
      // callback into $super -- Image.setImageURL's very first line is
      // `if (!url) { thenDo && thenDo(null, this); return null }`, so with
      // the blank placeholder url used here, any thenDo reaching $super
      // would fire immediately as "loaded" before real content exists,
      // then fire AGAIN once the real resolve completes. Callers get the
      // real, single-fire callback via _resolveAndDisplay instead.
      initialize: function ($super, bounds, fileRef, extentOptions) {
        $super(bounds, '', extentOptions);
        this.shape.fileHandle = fileRef.handle;
        this.shape.fileObjId = fileRef.objId;
        this._extentOptions = extentOptions;
      },

      _resolveAndDisplay: function (thenDo) {
        var self = this;
        lively.identity.fileCrypto.objectUrlFor(
          this.shape.fileHandle, this.shape.fileObjId,
          function (err, url) {
            if (err) {
              console.error('[EncryptedImage] resolve failed', err);
              thenDo && thenDo(err);
              return;
            }
            self.setImageURL(url, self._extentOptions, thenDo);
          },
        );
      },

      onrestore: function () {
        if (!this.shape || !this.shape.fileHandle || !this.shape.fileObjId) return;
        var self = this;
        this.whenOpenedInWorld(function () { self._resolveAndDisplay(); });
      },
    });

    // ─── Video / PDF shared shape ──────────────────────────────────────────

    function _loadingPlaceholder() {
      var el = document.createElement('div');
      el.style.cssText =
        'display:flex;align-items:center;justify-content:center;' +
        'width:100%;height:100%;box-sizing:border-box;' +
        'background:#f0f0f0;color:#888;font:13px Arial,sans-serif';
      el.textContent = 'Loading…';
      return el;
    }

    lively.morphic.Shapes.External.subclass('lively.morphic.Shapes.EncryptedExternal', {
      // Real content (a video's <source src>, a PDF's canvas bitmap + its
      // page-turn closures) must never be persisted -- the base class's
      // onstore/onrestore round-trips a stringified HTML snapshot, which
      // for PDF already produced a dead shell before any of this (a canvas
      // and addEventListener handlers don't survive HTML stringification),
      // and for video would bake a plaintext <source src> into every save
      // regardless of the blob's own visibility. Every restore instead
      // rebuilds fresh from fileHandle/fileObjId via the owning morph's
      // onrestore + _rebuildContent.
      onstore: function () {
        this.extent = this.getExtent();
      },

      onrestore: function () {
        this.shapeNode = _loadingPlaceholder();
      },
    });

    // ─── Video ─────────────────────────────────────────────────────────────

    lively.morphic.Morph.subclass('lively.data.FileUpload.EncryptedVideo', {
      // fileRef: {handle, objId}
      initialize: function ($super, fileRef, mime) {
        var shape = new lively.morphic.Shapes.EncryptedExternal(_loadingPlaceholder());
        shape.fileHandle = fileRef.handle;
        shape.fileObjId = fileRef.objId;
        shape.mime = mime;
        $super(shape);
        this.applyStyle({ borderWidth: 1, borderColor: Color.black, extent: pt(400, 300) });
      },

      _rebuildContent: function () {
        var self = this;
        lively.identity.fileCrypto.objectUrlFor(
          this.shape.fileHandle, this.shape.fileObjId,
          function (err, blobUrl) {
            if (err) { console.error('[EncryptedVideo] resolve failed', err); return; }
            var videoNode = lively.data.FileUpload.buildVideoNode(blobUrl, self.shape.mime);
            var node = self.shape.shapeNode;
            while (node.firstChild) node.removeChild(node.firstChild);
            node.appendChild(videoNode);
            self.setExtent(pt(videoNode.width || 400, videoNode.height || 300));
          },
        );
      },

      onrestore: function () {
        if (!this.shape || !this.shape.fileHandle) return;
        var self = this;
        this.whenOpenedInWorld(function () { self._rebuildContent(); });
      },
    });

    // ─── PDF ───────────────────────────────────────────────────────────────

    lively.morphic.Morph.subclass('lively.data.FileUpload.EncryptedPDF', {
      // fileRef: {handle, objId}
      initialize: function ($super, fileRef) {
        var shape = new lively.morphic.Shapes.EncryptedExternal(_loadingPlaceholder());
        shape.fileHandle = fileRef.handle;
        shape.fileObjId = fileRef.objId;
        $super(shape);
        this.applyStyle({ extent: pt(600, 800), borderWidth: 1, borderColor: Color.black });
      },

      // Uses fetchAndDecrypt (raw bytes), NOT objectUrlFor (a blob: URL) --
      // confirmed live that pdfjsLib.getDocument() cannot resolve a blob:
      // URL at all in this environment (see buildPDFContainer's own
      // comment for the isolated repro); {data: bytes} is what actually
      // works, so PDF is the one case here that needs raw bytes rather
      // than a resolved display URL.
      _rebuildContent: function () {
        var self = this;
        lively.identity.fileCrypto.fetchAndDecrypt(
          this.shape.fileHandle, this.shape.fileObjId,
          function (err, result) {
            if (err) { console.error('[EncryptedPDF] resolve failed', err); return; }
            var container = lively.data.FileUpload.buildPDFContainer(result.bytes);
            var node = self.shape.shapeNode;
            while (node.firstChild) node.removeChild(node.firstChild);
            node.appendChild(container);
          },
        );
      },

      onrestore: function () {
        if (!this.shape || !this.shape.fileHandle) return;
        var self = this;
        this.whenOpenedInWorld(function () { self._rebuildContent(); });
      },
    });

  });
