module('lively.data.PDFUpload').requires('lively.data.FileUpload').toRun(function() {

// Factored out so lively.data.EncryptedMedia's EncryptedPDF can rebuild the
// identical viewer both on fresh upload and on world restore, without
// duplicating this construction. Returns just the container DOM node --
// callers are responsible for wrapping it in a morph.
//
// urlOrBytes: a plain fetchable URL string, OR a Uint8Array of raw PDF
// bytes. Confirmed live: pdfjsLib.getDocument() cannot resolve a blob: URL
// at all in this environment -- reproduced in isolation with a valid
// minimal PDF, both as a bare string and as {url: blobUrl}, always failing
// with a mangled/doubled-origin "Missing PDF" error; {data: bytes} works
// correctly. So the encrypted path (lively.data.EncryptedMedia's
// EncryptedPDF) must hand this raw decrypted bytes, never a resolved
// blob: URL, unlike Image/Video (whose <img>/<video> src bindings DO
// support blob: URLs natively, confirmed working).
Object.extend(lively.data.FileUpload, {
    buildPDFContainer: function(urlOrBytes) {
        // Canvas-based PDF.js rendering: no iframe, so Ctrl+click → halos
        // works natively everywhere on the morph. Scroll within canvasWrapper
        // is captured by the div (parent document) — no subdocument isolation.
        var PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

        var canvas = document.createElement('canvas');
        canvas.style.cssText = 'display:block;background:#fff';

        var canvasWrapper = document.createElement('div');
        canvasWrapper.style.cssText = 'flex:1;overflow:auto;background:#888;display:flex;' +
            'justify-content:center;padding:8px;box-sizing:border-box';
        canvasWrapper.appendChild(canvas);

        var prevBtn = document.createElement('button');
        prevBtn.textContent = '← Prev';
        var pageInfo = document.createElement('span');
        pageInfo.style.cssText = 'font-size:12px;font-family:Arial,sans-serif;margin:0 8px';
        pageInfo.textContent = 'Loading…';
        var nextBtn = document.createElement('button');
        nextBtn.textContent = 'Next →';

        var navBar = document.createElement('div');
        navBar.style.cssText = 'display:flex;align-items:center;justify-content:center;' +
            'padding:4px 8px;background:rgba(60,60,60,0.1);' +
            'border-bottom:1px solid rgba(0,0,0,0.15);flex-shrink:0';
        navBar.appendChild(prevBtn);
        navBar.appendChild(pageInfo);
        navBar.appendChild(nextBtn);

        var container = document.createElement('div');
        container.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;' +
            'overflow:hidden;background:#fff';
        container.appendChild(navBar);
        container.appendChild(canvasWrapper);

        var pdfDoc = null, pageNum = 1, rendering = false;

        function renderPage(num) {
            if (!pdfDoc || rendering) return;
            rendering = true;
            pdfDoc.getPage(num).then(function(page) {
                var wrapperW = canvasWrapper.clientWidth - 16;
                var baseVp = page.getViewport({scale: 1});
                var scale = wrapperW > 0 ? wrapperW / baseVp.width : 1.5;
                var vp = page.getViewport({scale: scale});
                canvas.width = vp.width;
                canvas.height = vp.height;
                return page.render({canvasContext: canvas.getContext('2d'), viewport: vp}).promise;
            }).then(function() {
                pageInfo.textContent = 'Page ' + num + ' of ' + pdfDoc.numPages;
                rendering = false;
            }).catch(function(e) {
                pageInfo.textContent = 'Render error: ' + e.message;
                rendering = false;
            });
        }

        function initPDF() {
            var lib = window.pdfjsLib;
            if (!lib.GlobalWorkerOptions.workerSrc) {
                lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
            }
            var docParams = (urlOrBytes instanceof Uint8Array) ? { data: urlOrBytes } : urlOrBytes;
            lib.getDocument(docParams).promise.then(function(pdf) {
                pdfDoc = pdf;
                renderPage(1);
            }).catch(function(e) {
                pageInfo.textContent = 'Failed to load: ' + e.message;
            });
        }

        prevBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            if (pageNum > 1) { pageNum--; renderPage(pageNum); }
        });
        nextBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            if (pdfDoc && pageNum < pdfDoc.numPages) { pageNum++; renderPage(pageNum); }
        });

        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(function() {
                if (pdfDoc) renderPage(pageNum);
            }).observe(canvasWrapper);
        }

        if (window.pdfjsLib) {
            initPDF();
        } else {
            var script = document.createElement('script');
            script.src = PDFJS_URL;
            script.onload = initPDF;
            document.head.appendChild(script);
        }

        return container;
    },
});

lively.data.FileUpload.Handler.subclass('lively.data.PDFUpload.Handler', {
    handles: function(file) {
        return file.type.match(/application\/pdf/);
    },

    getUploadSpec: function(evt, file) {
        if (this.isIdentityUploadAvailable()) return {readMethod: "manual"};
        return {readMethod: "asBinary"};
    },
    readManually: function(file) {
        var self = this;
        self.identityUpload(file, function(err, ref) {
            if (err) { $world.inform("Error uploading PDF file:\n" + err); return; }
            var morph = self.openPDF(ref, file.type, self.pos);
            self.attachIdentityDelete(morph, { handle: ref.handle, blobCid: ref.blobCid });
        });
    },
    onLoad: function(evt) {
        this.uploadAndOpenPDFTo(
            URL.source.withFilename(this.file.name),
            this.file.type, evt.target.result, this.pos);
    },

    uploadAndOpenPDFTo: function(url, mime, binaryData, pos) {
        var self = this;
        this.uploadBinary(url, mime, binaryData, function(status) {
            if (!status.isDone()) return;
            if (status.isSuccess()) self.openPDF(url, mime, pos)
            else alert('Failure uploading ' + url + ': ' + status);
        });
    },

    // url: a plain fetchable URL (legacy/non-identity uploads, or the
    // local-dev-server fallback), OR {handle, objId} for an identity
    // upload -- the latter renders as encrypted content via
    // lively.data.EncryptedMedia's EncryptedPDF instead of a plain
    // pdfjsLib.getDocument(url) call against ciphertext, since that can
    // never decrypt private content (confirmed live: it doesn't even work
    // for the owner).
    openPDF: function(url, mime, pos) {
        if (url && typeof url === 'object') {
            var encMorph = new lively.data.FileUpload.EncryptedPDF(url);
            encMorph.openInWorld(pos);
            encMorph._rebuildContent();
            return encMorph;
        }

        var container = lively.data.FileUpload.buildPDFContainer(url);
        var morph = new lively.morphic.Morph(new lively.morphic.Shapes.External(container));
        morph.applyStyle({extent: pt(600, 800), borderWidth: 1, borderColor: Color.black});
        morph.openInWorld(pos);
        return morph;
    },

});

}) // end of module
