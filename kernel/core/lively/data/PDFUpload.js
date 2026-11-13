module('lively.data.PDFUpload').requires('lively.data.FileUpload').toRun(function() {

// ---------------------------------------------------------------------------------------------------------------------------------
// The PDF viewer. A page is drawn on a canvas by pdf.js, with the page's text laid over it (transparent, so it can be selected and
// searched), the person's highlights under that, and the hits of a search under that. One page at a time, with a zoom, a side panel
// (outline, small pictures of the pages, the highlights with their notes), and find.
//
// No iframe: Ctrl+click halos keep working on the morph, and the scroll of the page is the page's own.
// Highlights are kept as fractions of the page's width and height, so they stay where they are at any zoom and size of the box.
// They are not written into the PDF: they go through opts.notes to wherever the caller keeps them (for a library file: the sealed
// sidecar record the shell keeps for that file). Without opts.notes the viewer offers no highlighting.
// ---------------------------------------------------------------------------------------------------------------------------------

var KPV_STEPS = [50, 75, 100, 125, 150, 200, 300, 400];     // percent; 100 % is the usual 96-pixel inch (pdf.js scale 1 is 72)
var KPV_MAX_HITS = 5000;
var KPV_SAVE_DELAY = 500;
var KPV_CSS = [
    '.kpv{width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;background:#fff;font:12px Arial,sans-serif;color:#1f2937;box-sizing:border-box}',
    '.kpv *{box-sizing:border-box}',
    '.kpv-bar{display:flex;align-items:center;gap:2px;padding:4px 6px;background:#f1f5f9;border-bottom:1px solid #cbd5e1;flex-shrink:0;overflow:hidden;white-space:nowrap}',
    '.kpv-btn{font-family:"Material Symbols Rounded";font-size:20px;line-height:1;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:#334155;cursor:pointer;padding:0;flex-shrink:0;font-weight:normal}',
    '.kpv-btn:hover:not(:disabled){background:#dbeafe}',
    '.kpv-btn:disabled{color:#cbd5e1;cursor:default}',
    '.kpv-btn.on{background:#dbeafe;color:#2563eb}',
    '.kpv-txtbtn{font:bold 12px Arial,sans-serif}',
    '.kpv-sep{width:1px;height:18px;background:#cbd5e1;margin:0 4px;flex-shrink:0}',
    '.kpv-info{margin:0 4px;min-width:84px;text-align:center;flex-shrink:0}',
    '.kpv-zoom{font:12px Arial,sans-serif;height:26px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#1f2937;flex-shrink:0}',
    '.kpv-status{flex:1;min-width:0;text-align:right;color:#64748b;overflow:hidden;text-overflow:ellipsis;padding-left:6px}',
    '.kpv-status.bad{color:#b91c1c}',
    '.kpv-find{display:none;align-items:center;gap:2px;padding:4px 6px;background:#f8fafc;border-bottom:1px solid #cbd5e1;flex-shrink:0}',
    '.kpv-find.open{display:flex}',
    '.kpv-find input{flex:1;min-width:60px;height:26px;border:1px solid #cbd5e1;border-radius:6px;padding:0 8px;font:12px Arial,sans-serif;background:#fff;color:#1f2937}',
    '.kpv-find input:focus{outline:2px solid #93c5fd;border-color:#2563eb}',
    '.kpv-count{min-width:70px;text-align:center;color:#475569;flex-shrink:0}',
    '.kpv-body{flex:1;display:flex;min-height:0}',
    '.kpv-side{display:none;width:190px;flex-shrink:0;flex-direction:column;border-right:1px solid #cbd5e1;background:#f8fafc}',
    '.kpv-side.open{display:flex}',
    '.kpv-tabs{display:flex;border-bottom:1px solid #e2e8f0;flex-shrink:0}',
    '.kpv-tab{flex:1;padding:7px 0;border:0;border-bottom:2px solid transparent;background:transparent;cursor:pointer;font:12px Arial,sans-serif;color:#475569}',
    '.kpv-tab.on{border-bottom-color:#2563eb;color:#2563eb}',
    '.kpv-pane{display:none;flex:1;overflow:auto;padding:4px;min-height:0}',
    '.kpv-pane.open{display:block}',
    '.kpv-empty{padding:10px 8px;color:#64748b}',
    '.kpv-row{display:flex;align-items:flex-start;gap:2px;padding:3px 4px;border-radius:5px;cursor:pointer;line-height:1.3}',
    '.kpv-row:hover{background:#eff6ff}',
    '.kpv-row.nolink{cursor:default;color:#64748b}',
    '.kpv-row.nolink:hover{background:transparent}',
    '.kpv-tw{font-family:"Material Symbols Rounded";font-size:16px;line-height:1.2;width:16px;flex-shrink:0;color:#64748b;text-align:center}',
    '.kpv-tt{flex:1;min-width:0;overflow-wrap:anywhere}',
    '.kpv-thumb{display:block;margin:6px auto;padding:4px;border:2px solid transparent;border-radius:6px;cursor:pointer;text-align:center;background:transparent}',
    '.kpv-thumb:hover{background:#eff6ff}',
    '.kpv-thumb.cur{border-color:#2563eb;background:#dbeafe}',
    '.kpv-thumb canvas{display:block;margin:0 auto;background:#fff;box-shadow:0 0 0 1px #cbd5e1}',
    '.kpv-thumb span{display:block;margin-top:3px;color:#475569}',
    '.kpv-note{padding:6px;margin:4px 0;border-radius:6px;background:#fff;border:1px solid #e2e8f0;cursor:pointer}',
    '.kpv-note:hover{border-color:#93c5fd}',
    '.kpv-note b{display:block;color:#475569;font-weight:normal;margin-bottom:2px}',
    '.kpv-note i{display:block;margin-top:3px;color:#1f2937;font-style:normal;border-left:3px solid #f59e0b;padding-left:5px;overflow-wrap:anywhere}',
    '.kpv-view{flex:1;min-width:0;overflow:auto;background:#888;padding:8px;scrollbar-gutter:stable}',
    '.kpv-page{position:relative;margin:0 auto;background:#fff}',
    '.kpv-page canvas{display:block}',
    '.kpv-layer{position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none}',
    '.kpv-layer div{position:absolute}',
    '.kpv-hl div{background:rgba(255,213,0,.5);mix-blend-mode:multiply}',
    '.kpv-hl div.note{border-bottom:2px solid #d97706}',
    '.kpv-hits div{background:rgba(37,99,235,.28)}',
    '.kpv-hits div.cur{background:rgba(249,115,22,.55)}',
    '.kpv-text{position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;line-height:1;text-size-adjust:none;transform-origin:0 0}',
    '.kpv-text span{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%}',
    '.kpv-text ::selection{background:rgba(37,99,235,.35)}',
    // the world switches text selection off for everything in it (user-select: none, inherited); the page's text, the note and the find box need it back
    '.kpv-text,.kpv-text span,.kpv-pop textarea,.kpv-find input{user-select:text;-webkit-user-select:text}',
    // the links of the page, over its text: the layer lets the pointer through, the links themselves take it
    '.kpv-links a{position:absolute;display:block;cursor:pointer;pointer-events:auto;border-radius:2px}',
    '.kpv-links a:hover,.kpv-links a:focus-visible{background:rgba(37,99,235,.14);outline:1px solid rgba(37,99,235,.55)}',
    '.kpv-pop{position:absolute;z-index:5;width:240px;padding:8px;background:#fff;border:1px solid #94a3b8;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.25)}',
    '.kpv-pop textarea{display:block;width:100%;height:84px;resize:vertical;border:1px solid #cbd5e1;border-radius:6px;padding:6px;font:12px Arial,sans-serif;color:#1f2937}',
    '.kpv-pop textarea:focus{outline:2px solid #93c5fd;border-color:#2563eb}',
    '.kpv-pop-row{display:flex;gap:6px;margin-top:6px;justify-content:flex-end}',
    '.kpv-pop-row button{height:26px;padding:0 10px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#1f2937;cursor:pointer;font:12px Arial,sans-serif}',
    '.kpv-pop-row button.go{background:#2f9e5b;border-color:#2f9e5b;color:#fff}',
    '.kpv-pop-row button.del{color:#b91c1c;margin-right:auto}',
    '.kpv-pop small{display:block;margin-bottom:5px;color:#475569;overflow-wrap:anywhere;max-height:3.9em;overflow:hidden}'
].join('\n');

function kpvStyles() {
    if (document.getElementById('kpv-styles')) return;
    var s = document.createElement('style');
    s.id = 'kpv-styles';
    s.textContent = KPV_CSS;
    document.head.appendChild(s);
}
function kpvEl(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}
function kpvIconBtn(glyph, title, act) {
    var b = kpvEl('button', 'kpv-btn', glyph);
    b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.setAttribute('data-act', act);
    return b;
}
function kpvId() {
    var a = new Uint8Array(9), s = '';
    crypto.getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
    return s;
}
// A phrase for the person when pdf.js cannot open the file.
function kpvLoadError(e) {
    if (e && e.name === 'PasswordException') return 'This PDF is protected by a password, and keo cannot open those yet.';
    return 'Failed to load: ' + (e && e.message || e);
}

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
//
// opts.notes: { load(thenDo(err, doc|null)), save(doc, thenDo(err)) } where doc is { highlights: [...], removed: [...] }. Highlights
// are offered only when it is given. Nothing is saved before load has answered, so a notes record that could not be read is never
// overwritten by an empty one.
Object.extend(lively.data.FileUpload, {
    buildPDFContainer: function(urlOrBytes, opts) {
        opts = opts || {};
        var notesApi = opts.notes || null;
        // pdf.js 3.11.174 is part of the runtime (core/lib/pdfjs), not fetched from a CDN: the world may load scripts from its own
        // package only, and a viewer that needs the network is no viewer on a webputer that is offline.
        var PDFJS_URL = Config.codeBase + 'lib/pdfjs/pdf.min.js';
        var PDFJS_WORKER = Config.codeBase + 'lib/pdfjs/pdf.worker.min.js';
        kpvStyles();

        // ---- the parts -------------------------------------------------------------------------------------------------------
        var sideBtn = kpvIconBtn('menu', 'Outline, pages and notes', 'side');
        var prevBtn = kpvIconBtn('chevron_left', 'Previous page', 'prev');
        var pageInfo = kpvEl('span', 'kpv-info', 'Loading…');
        var nextBtn = kpvIconBtn('chevron_right', 'Next page', 'next');
        var zoomOutBtn = kpvIconBtn('zoom_out', 'Zoom out', 'zoomout');
        var zoomSel = kpvEl('select', 'kpv-zoom');
        zoomSel.title = 'Zoom'; zoomSel.setAttribute('data-act', 'zoom');
        [['width', 'Fit width'], ['page', 'Fit page']].concat(KPV_STEPS.map(function(p) { return [String(p), p + '%']; })).forEach(function(o) {
            var op = kpvEl('option', null, o[1]); op.value = o[0]; zoomSel.appendChild(op);
        });
        var zoomInBtn = kpvIconBtn('zoom_in', 'Zoom in', 'zoomin');
        var findBtn = kpvIconBtn('search', 'Find in this document', 'find');
        var hlBtn = kpvIconBtn('border_color', 'Highlight the selected text', 'highlight');
        hlBtn.disabled = true;
        var status = kpvEl('span', 'kpv-status');

        var bar = kpvEl('div', 'kpv-bar');
        [sideBtn, kpvEl('div', 'kpv-sep'), prevBtn, pageInfo, nextBtn, kpvEl('div', 'kpv-sep'), zoomOutBtn, zoomSel, zoomInBtn, kpvEl('div', 'kpv-sep'), findBtn].forEach(function(n) { bar.appendChild(n); });
        if (notesApi) bar.appendChild(hlBtn);
        bar.appendChild(status);

        var findBar = kpvEl('div', 'kpv-find');
        var findInput = kpvEl('input'); findInput.type = 'text'; findInput.placeholder = 'Find in this document'; findInput.setAttribute('data-act', 'findtext');
        var caseBtn = kpvEl('button', 'kpv-btn kpv-txtbtn', 'Aa'); caseBtn.type = 'button'; caseBtn.title = 'Match case'; caseBtn.setAttribute('data-act', 'case');
        var findCount = kpvEl('span', 'kpv-count');
        var hitPrev = kpvIconBtn('keyboard_arrow_up', 'Previous match', 'hitprev');
        var hitNext = kpvIconBtn('keyboard_arrow_down', 'Next match', 'hitnext');
        var findClose = kpvIconBtn('close', 'Close', 'findclose');
        [findInput, caseBtn, findCount, hitPrev, hitNext, findClose].forEach(function(n) { findBar.appendChild(n); });

        var side = kpvEl('div', 'kpv-side');
        var tabs = kpvEl('div', 'kpv-tabs');
        var tabDefs = [['outline', 'Outline'], ['pages', 'Pages']].concat(notesApi ? [['notes', 'Notes']] : []);
        var tabBtns = {}, panes = {};
        tabDefs.forEach(function(t) {
            var b = kpvEl('button', 'kpv-tab', t[1]); b.type = 'button'; b.setAttribute('data-tab', t[0]); tabBtns[t[0]] = b; tabs.appendChild(b);
        });
        side.appendChild(tabs);
        tabDefs.forEach(function(t) { var p = kpvEl('div', 'kpv-pane'); p.setAttribute('data-pane', t[0]); panes[t[0]] = p; side.appendChild(p); });

        var view = kpvEl('div', 'kpv-view');
        var pageBox = kpvEl('div', 'kpv-page');
        var canvas = kpvEl('canvas');
        var hlLayer = kpvEl('div', 'kpv-layer kpv-hl');
        var hitLayer = kpvEl('div', 'kpv-layer kpv-hits');
        var textLayer = kpvEl('div', 'kpv-text');
        var linkLayer = kpvEl('div', 'kpv-layer kpv-links');
        [canvas, hlLayer, hitLayer, textLayer, linkLayer].forEach(function(n) { pageBox.appendChild(n); });
        view.appendChild(pageBox);

        var body = kpvEl('div', 'kpv-body');
        body.appendChild(side); body.appendChild(view);
        var container = kpvEl('div', 'kpv');
        container.appendChild(bar); container.appendChild(findBar); container.appendChild(body);

        // ---- state -----------------------------------------------------------------------------------------------------------
        var pdfDoc = null, pageNum = 1, rendering = false, again = false;
        var zoomMode = 'width';                // 'width', 'page' or a percent (number)
        var lastScale = 1, lastAvail = '';
        var textDivs = [], textStrs = [];       // of the page on show, in step with each other
        var tab = 'outline', outlineBuilt = false, thumbsBuilt = false;
        var pageTexts = {};                     // page number -> { text, starts[] }, filled by a search
        var query = '', matchCase = false, hits = [], hitIx = -1, searchToken = 0, searchTimer = null;
        var notesDoc = { highlights: [], removed: [] }, notesReady = false, saveTimer = null, saving = false, saveAgain = false;
        var popup = null, hitScroll = false;     // hitScroll: the page being drawn is for a hit, which is to be scrolled to
        var selInfo = null;                     // the selection on the page: { text, rects } or null

        function say(text, bad) { status.textContent = text || ''; status.className = 'kpv-status' + (bad ? ' bad' : ''); }
        function updateNav() {
            var n = pdfDoc ? pdfDoc.numPages : 0;
            prevBtn.disabled = !pdfDoc || pageNum <= 1;
            nextBtn.disabled = !pdfDoc || pageNum >= n;
            zoomOutBtn.disabled = zoomInBtn.disabled = !pdfDoc;
            if (pdfDoc) pageInfo.textContent = 'Page ' + pageNum + ' of ' + n;
            Array.prototype.forEach.call(panes.pages ? panes.pages.querySelectorAll('.kpv-thumb') : [], function(t) {
                t.className = 'kpv-thumb' + (Number(t.getAttribute('data-page')) === pageNum ? ' cur' : '');
            });
        }

        // ---- drawing a page --------------------------------------------------------------------------------------------------
        function scaleFor(base) {
            var availW = Math.max(40, view.clientWidth - 16), availH = Math.max(40, view.clientHeight - 16);
            if (zoomMode === 'width') return Math.min(6, availW / base.width);
            if (zoomMode === 'page') return Math.min(6, availW / base.width, availH / base.height);
            return zoomMode / 100 * (96 / 72);
        }
        function render() {
            if (!pdfDoc) return;
            if (rendering) { again = true; return; }
            rendering = true; again = false;
            var num = pageNum, page = null, vp = null, fresh = kpvEl('canvas');
            pdfDoc.getPage(num).then(function(p) {
                page = p;
                var base = page.getViewport({scale: 1});
                lastScale = scaleFor(base);
                lastAvail = view.clientWidth + 'x' + view.clientHeight;
                vp = page.getViewport({scale: lastScale});
                var dpr = window.devicePixelRatio || 1;
                fresh.width = Math.max(1, Math.floor(vp.width * dpr));
                fresh.height = Math.max(1, Math.floor(vp.height * dpr));
                fresh.style.width = vp.width + 'px';
                fresh.style.height = vp.height + 'px';
                return page.render({canvasContext: fresh.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null}).promise;
            }).then(function() {
                // swap in only when the whole page is drawn, so a zoom does not flash an empty page
                pageBox.style.width = vp.width + 'px';
                pageBox.style.height = vp.height + 'px';
                pageBox.replaceChild(fresh, canvas);
                canvas = fresh;
                return page.getTextContent();
            }).then(function(tc) {
                var layer = kpvEl('div', 'kpv-text');
                layer.style.setProperty('--scale-factor', String(vp.scale));
                pageBox.replaceChild(layer, textLayer);
                textLayer = layer;
                textDivs = []; textStrs = [];
                var task = window.pdfjsLib.renderTextLayer({textContentSource: tc, container: layer, viewport: vp, textDivs: textDivs, textContentItemsStr: textStrs});
                return task.promise;
            }).then(function() {
                var scrollToHit = hitScroll; hitScroll = false;
                drawHighlights(); drawHits(scrollToHit);
                return drawLinks(page, vp);
            }).then(function() {
                pageBox.setAttribute('data-drawn', num + '@' + Math.round(lastScale * 1000));      // which page at which size is on show (for tests too)
            }).catch(function(e) {
                if (!(e && e.name === 'RenderingCancelledException')) pageInfo.textContent = 'Render error: ' + (e && e.message || e);
            }).then(function() {
                rendering = false;
                updateNav();
                if (zoomMode !== 'width' && zoomMode !== 'page') zoomSel.value = String(zoomMode);
                if (again || lastAvail !== view.clientWidth + 'x' + view.clientHeight) render();
            });
        }
        // ---- links ---------------------------------------------------------------------------------------------------------
        // The links the page has: one clickable area over each. A link to another place in the file goes there; a link to an outside address
        // is never followed from here: it goes to the warning (lively.identity.LinkWarning), which asks the shell and opens nothing until the
        // person says so. Outside keo there is nobody to ask, so only the links inside the file are drawn.
        var canLink = !!(window.keo && typeof window.keo.call === 'function');
        function textUnder(el) {
            var r = el.getBoundingClientRect(), out = [];
            for (var i = 0; i < textDivs.length; i++) {
                var b = textDivs[i].getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
                if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) out.push(textStrs[i] != null ? textStrs[i] : textDivs[i].textContent);
            }
            return out.join('').trim().slice(0, 300);
        }
        function followLink(el) {
            var to = el._kpvUrl;
            if (to) {
                var said = textUnder(el);
                lively.require('lively.identity.LinkWarning').toRun(function() { lively.identity.LinkWarning.go(to, { text: said, source: opts.name || 'a PDF' }); });
                return;
            }
            destPage(el._kpvDest).then(function(i) { if (typeof i === 'number') goPage(i + 1); });
        }
        function drawLinks(page, vp) {
            var layer = kpvEl('div', 'kpv-layer kpv-links');
            pageBox.replaceChild(layer, linkLayer);
            linkLayer = layer;
            return page.getAnnotations({intent: 'display'}).then(function(list) {
                var n = 0;
                (list || []).forEach(function(a) {
                    if (!a || a.subtype !== 'Link' || !a.rect || n >= 300) return;
                    var to = typeof (a.url || a.unsafeUrl) === 'string' ? String(a.url || a.unsafeUrl) : '';
                    if (!to && !(a.dest !== undefined && a.dest !== null)) return;
                    if (to && !canLink) return;
                    var r = vp.convertToViewportRectangle(a.rect), x = Math.min(r[0], r[2]), y = Math.min(r[1], r[3]), w = Math.abs(r[2] - r[0]), h = Math.abs(r[3] - r[1]);
                    if (!(w >= 2 && h >= 2)) return;
                    var el = kpvEl('a');
                    el.setAttribute('role', 'link'); el.tabIndex = 0;
                    el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.width = w + 'px'; el.style.height = h + 'px';
                    el.title = to ? to.slice(0, 200) : 'Go to the place this link names';
                    el._kpvUrl = to; el._kpvDest = to ? null : a.dest;
                    el.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); followLink(el); });
                    el.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); followLink(el); } });
                    layer.appendChild(el); n++;
                });
            }, function() { /* a page whose links cannot be read still shows */ });
        }
        function goPage(n, keepScroll) {
            if (!pdfDoc) return;
            n = Math.max(1, Math.min(pdfDoc.numPages, n));
            closePopup();
            var moved = n !== pageNum;
            pageNum = n;
            if (moved && !keepScroll) view.scrollTop = 0;
            updateNav();
            render();
        }

        // ---- zoom ------------------------------------------------------------------------------------------------------------
        function stepZoom(dir) {
            var cur = zoomMode === 'width' || zoomMode === 'page' ? Math.round(lastScale / (96 / 72) * 100) : zoomMode, ix = -1, i;
            if (dir > 0) { for (i = 0; i < KPV_STEPS.length; i++) if (KPV_STEPS[i] > cur + 0.5) { ix = i; break; } if (ix < 0) return; }
            else { for (i = KPV_STEPS.length - 1; i >= 0; i--) if (KPV_STEPS[i] < cur - 0.5) { ix = i; break; } if (ix < 0) return; }
            setZoom(KPV_STEPS[ix]);
        }
        function setZoom(mode) {
            zoomMode = mode === 'width' || mode === 'page' ? mode : Number(mode);
            zoomSel.value = String(zoomMode);
            render();
        }

        // ---- the side panel --------------------------------------------------------------------------------------------------
        function showTab(name) {
            tab = name;
            Object.keys(panes).forEach(function(k) {
                panes[k].className = 'kpv-pane' + (k === name ? ' open' : '');
                tabBtns[k].className = 'kpv-tab' + (k === name ? ' on' : '');
            });
            if (name === 'outline' && !outlineBuilt && pdfDoc) buildOutline();
            if (name === 'pages' && !thumbsBuilt && pdfDoc) buildThumbs();
            if (name === 'notes') buildNotesList();
        }
        function toggleSide() {
            var open = side.className.indexOf('open') < 0;
            side.className = 'kpv-side' + (open ? ' open' : '');
            sideBtn.className = 'kpv-btn' + (open ? ' on' : '');
            if (open) showTab(tab);
        }
        // a destination is a name, or an array whose first member names a page (a reference, or a number)
        function destPage(dest) {
            if (typeof dest === 'string') return pdfDoc.getDestination(dest).then(function(d) { return d ? destPage(d) : null; }, function() { return null; });
            if (Array.isArray(dest) && dest.length) {
                var r = dest[0];
                if (typeof r === 'number') return Promise.resolve(r);
                if (r && typeof r === 'object') return pdfDoc.getPageIndex(r).then(function(i) { return i; }, function() { return null; });
            }
            return Promise.resolve(null);
        }
        function buildOutline() {
            outlineBuilt = true;
            var pane = panes.outline;
            pane.appendChild(kpvEl('div', 'kpv-empty', 'Reading the outline…'));
            pdfDoc.getOutline().then(function(items) {
                pane.textContent = '';
                if (!items || !items.length) { pane.appendChild(kpvEl('div', 'kpv-empty', 'This document has no outline.')); return; }
                var total = 0;
                (function count(list) { list.forEach(function(it) { total++; if (it.items) count(it.items); }); })(items);
                var openAll = total <= 40;
                (function add(list, into, depth) {
                    list.forEach(function(it) {
                        var kids = it.items && it.items.length ? it.items : null;
                        var row = kpvEl('div', 'kpv-row' + (it.dest ? '' : ' nolink'));
                        row.style.paddingLeft = (4 + depth * 12) + 'px';
                        var tw = kpvEl('span', 'kpv-tw', kids ? (openAll ? 'expand_more' : 'chevron_right') : '');
                        var tt = kpvEl('span', 'kpv-tt', it.title || '(no title)');
                        if (it.bold) tt.style.fontWeight = 'bold';
                        if (it.italic) tt.style.fontStyle = 'italic';
                        row.appendChild(tw); row.appendChild(tt);
                        into.appendChild(row);
                        var sub = null;
                        if (kids) {
                            sub = kpvEl('div'); sub.style.display = openAll ? 'block' : 'none';
                            into.appendChild(sub);
                            add(kids, sub, depth + 1);
                            tw.addEventListener('click', function(e) {
                                e.stopPropagation();
                                var show = sub.style.display === 'none';
                                sub.style.display = show ? 'block' : 'none';
                                tw.textContent = show ? 'expand_more' : 'chevron_right';
                            });
                        }
                        if (it.dest) row.addEventListener('click', function() {
                            destPage(it.dest).then(function(ix) { if (ix != null) goPage(ix + 1); });
                        });
                    });
                })(items, pane, 0);
            }).catch(function() { pane.textContent = ''; pane.appendChild(kpvEl('div', 'kpv-empty', 'The outline could not be read.')); });
        }
        function buildThumbs() {
            thumbsBuilt = true;
            var pane = panes.pages, n = pdfDoc.numPages, queue = [], busy = false;
            var items = [];
            function pump() {
                if (busy || !queue.length) return;
                busy = true;
                var it = queue.shift();
                pdfDoc.getPage(it.num).then(function(page) {
                    var base = page.getViewport({scale: 1}), sc = 120 / base.width, vp = page.getViewport({scale: sc});
                    var c = kpvEl('canvas');
                    c.width = Math.max(1, Math.floor(vp.width)); c.height = Math.max(1, Math.floor(vp.height));
                    return page.render({canvasContext: c.getContext('2d'), viewport: vp}).promise.then(function() {
                        it.holder.textContent = ''; it.holder.appendChild(c);
                    });
                }).catch(function() {}).then(function() { busy = false; pump(); });
            }
            var io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(function(entries) {
                entries.forEach(function(en) {
                    if (!en.isIntersecting) return;
                    io.unobserve(en.target);
                    var it = en.target.__kpv; if (it && !it.queued) { it.queued = true; queue.push(it); pump(); }
                });
            }, {root: pane, rootMargin: '200px'}) : null;
            for (var i = 1; i <= n; i++) {
                (function(num) {
                    var th = kpvEl('div', 'kpv-thumb' + (num === pageNum ? ' cur' : ''));
                    th.setAttribute('data-page', String(num));
                    var holder = kpvEl('div'); holder.style.cssText = 'width:120px;height:160px;margin:0 auto;background:#fff;box-shadow:0 0 0 1px #cbd5e1';
                    th.appendChild(holder); th.appendChild(kpvEl('span', null, String(num)));
                    th.addEventListener('click', function() { goPage(num); });
                    var it = {num: num, holder: holder, queued: false};
                    th.__kpv = it; items.push(it);
                    pane.appendChild(th);
                    if (io) io.observe(th); else { it.queued = true; queue.push(it); }
                })(i);
            }
            pump();
        }

        // ---- find ------------------------------------------------------------------------------------------------------------
        // The text of a page as one string, with where each piece (item) of it begins; a line break counts as a space.
        function pageText(num) {
            if (pageTexts[num]) return Promise.resolve(pageTexts[num]);
            return pdfDoc.getPage(num).then(function(p) { return p.getTextContent(); }).then(function(tc) {
                var text = '', starts = [], strs = [];
                tc.items.forEach(function(it) {
                    if (typeof it.str !== 'string') return;
                    starts.push(text.length); strs.push(it.str);
                    text += it.str + (it.hasEOL ? ' ' : '');
                });
                return (pageTexts[num] = {text: text, starts: starts, strs: strs});
            });
        }
        function foldCase(s) { var l = s.toLowerCase(); return l.length === s.length ? l : s; }
        function updateFindCount(searching) {
            if (!query) { findCount.textContent = ''; return; }
            if (!hits.length) { findCount.textContent = searching ? 'Searching…' : 'No results'; return; }
            findCount.textContent = (hitIx + 1) + ' of ' + hits.length + (hits.length >= KPV_MAX_HITS ? '+' : '') + (searching ? '…' : '');
        }
        function runSearch() {
            var token = ++searchToken, q = findInput.value;
            query = q; hits = []; hitIx = -1;
            drawHits(false); updateFindCount(false);
            hitPrev.disabled = hitNext.disabled = true;
            if (!q || !pdfDoc) return;
            var needle = matchCase ? q : foldCase(q), n = pdfDoc.numPages, num = 1;
            updateFindCount(true);
            function step() {
                if (token !== searchToken) return;
                if (num > n || hits.length >= KPV_MAX_HITS) { updateFindCount(false); return; }
                var here = num++;
                pageText(here).then(function(pt) {
                    if (token !== searchToken) return;
                    var hay = matchCase ? pt.text : foldCase(pt.text), at = 0, found;
                    while (hits.length < KPV_MAX_HITS && (found = hay.indexOf(needle, at)) >= 0) {
                        hits.push({page: here, start: found, end: found + needle.length});
                        at = found + Math.max(1, needle.length);
                    }
                    if (hitIx < 0 && hits.length) {
                        // the first hit at or after the page on show, if this page or a later one has it; else the first of all
                        hitIx = 0; hitPrev.disabled = hitNext.disabled = false;
                        showHit(false);
                    }
                    updateFindCount(true);
                    setTimeout(step, 0);
                }, function() { setTimeout(step, 0); });
            }
            step();
        }
        function showHit(scroll) {
            if (hitIx < 0 || hitIx >= hits.length) return;
            var h = hits[hitIx];
            updateFindCount(false);
            if (h.page !== pageNum) { hitScroll = scroll !== false; goPage(h.page, true); return; }     // the hits are drawn when the page is
            drawHits(scroll !== false);
        }
        function nextHit(dir) {
            if (!hits.length) return;
            hitIx = (hitIx + dir + hits.length) % hits.length;
            showHit(true);
        }
        // Rectangles (fractions of the page) of a stretch of one page's text, found on the text layer that is drawn.
        function rectsOf(start, end, pt) {
            var out = [], box = pageBox.getBoundingClientRect();
            if (!box.width || !box.height || textDivs.length !== pt.starts.length) return out;
            for (var i = 0; i < pt.starts.length; i++) {
                var s = pt.starts[i], e = s + pt.strs[i].length;
                if (e <= start || s >= end) continue;
                var node = textDivs[i] && textDivs[i].firstChild;
                if (!node || node.nodeType !== 3) continue;
                var r = document.createRange();
                try { r.setStart(node, Math.max(0, start - s)); r.setEnd(node, Math.min(pt.strs[i].length, end - s)); } catch (x) { continue; }
                Array.prototype.forEach.call(r.getClientRects(), function(c) {
                    if (c.width < 0.5 || c.height < 0.5) return;
                    out.push([(c.left - box.left) / box.width, (c.top - box.top) / box.height, c.width / box.width, c.height / box.height]);
                });
            }
            return out;
        }
        function drawHits(scroll) {
            hitLayer.textContent = '';
            if (!hits.length || !pdfDoc) return;
            var pt = pageTexts[pageNum];
            if (!pt) return;
            var first = null;
            hits.forEach(function(h, i) {
                if (h.page !== pageNum) return;
                rectsOf(h.start, h.end, pt).forEach(function(r) {
                    var d = kpvEl('div', i === hitIx ? 'cur' : '');
                    place(d, r); hitLayer.appendChild(d);
                    if (i === hitIx && !first) first = d;
                });
            });
            if (first && scroll) {
                var top = first.offsetTop + pageBox.offsetTop;
                if (top < view.scrollTop + 20 || top > view.scrollTop + view.clientHeight - 60) view.scrollTop = Math.max(0, top - view.clientHeight / 3);
            }
        }
        function place(d, r) {
            d.style.left = (r[0] * 100) + '%'; d.style.top = (r[1] * 100) + '%';
            d.style.width = (r[2] * 100) + '%'; d.style.height = (r[3] * 100) + '%';
        }
        function openFind() {
            findBar.className = 'kpv-find open'; findBtn.className = 'kpv-btn on';
            findInput.focus(); findInput.select();
        }
        function closeFind() {
            findBar.className = 'kpv-find'; findBtn.className = 'kpv-btn';
            searchToken++; hits = []; hitIx = -1; query = ''; findInput.value = '';
            drawHits(false); updateFindCount(false);
        }

        // ---- highlights and notes --------------------------------------------------------------------------------------------
        function liveHighlights() { return notesDoc.highlights; }
        function drawHighlights() {
            hlLayer.textContent = '';
            liveHighlights().forEach(function(h) {
                if (h.page !== pageNum) return;
                h.rects.forEach(function(r) { var d = kpvEl('div', h.note ? 'note' : ''); place(d, r); hlLayer.appendChild(d); });
            });
        }
        function scheduleSave() {
            if (!notesApi || !notesReady) return;
            say('Saving…');
            clearTimeout(saveTimer);
            saveTimer = setTimeout(saveNow, KPV_SAVE_DELAY);
        }
        function saveNow() {
            clearTimeout(saveTimer); saveTimer = null;
            if (saving) { saveAgain = true; return; }
            saving = true; saveAgain = false;
            notesApi.save(JSON.parse(JSON.stringify(notesDoc)), function(err) {
                saving = false;
                if (err) say('The notes could not be saved: ' + (err.message || err), true);
                else if (!saveAgain && !saveTimer) { say('Saved'); setTimeout(function() { if (status.textContent === 'Saved') say(''); }, 1500); }
                if (saveAgain) saveNow();
            });
        }
        // Merges the rectangles a selection gives (one or more per piece of text, some twice) into one per line, as fractions of the page.
        function selectionRects(range) {
            var box = pageBox.getBoundingClientRect(), raw = [];
            if (!box.width || !box.height) return [];
            Array.prototype.forEach.call(range.getClientRects(), function(c) {
                if (c.width < 1 || c.height < 1 || c.width > box.width * 1.01 || c.height > box.height * 0.2) return;
                raw.push({l: c.left - box.left, t: c.top - box.top, r: c.right - box.left, b: c.bottom - box.top});
            });
            raw.sort(function(a, b) { return a.t - b.t || a.l - b.l; });
            var lines = [];
            raw.forEach(function(c) {
                var h = c.b - c.t;
                for (var i = lines.length - 1; i >= 0 && i >= lines.length - 3; i--) {
                    var m = lines[i], mh = m.b - m.t;
                    if (Math.abs(c.t - m.t) < Math.min(h, mh) * 0.6 && c.l <= m.r + Math.max(h, mh) * 0.6 && c.r >= m.l - Math.max(h, mh) * 0.6) {
                        m.l = Math.min(m.l, c.l); m.r = Math.max(m.r, c.r); m.t = Math.min(m.t, c.t); m.b = Math.max(m.b, c.b);
                        return;
                    }
                }
                lines.push({l: c.l, t: c.t, r: c.r, b: c.b});
            });
            return lines.slice(0, 100).map(function(m) {
                var l = Math.max(0, m.l), t = Math.max(0, m.t), r = Math.min(box.width, m.r), b = Math.min(box.height, m.b);
                return [l / box.width, t / box.height, (r - l) / box.width, (b - t) / box.height];
            }).filter(function(r) { return r[2] > 0 && r[3] > 0; });
        }
        function readSelection() {
            selInfo = null;
            var sel = window.getSelection();
            if (sel && sel.rangeCount && !sel.isCollapsed && textLayer.contains(sel.anchorNode) && textLayer.contains(sel.focusNode)) {
                var range = sel.getRangeAt(0), rects = selectionRects(range), text = String(sel).replace(/\s+/g, ' ').trim();
                if (rects.length && text) selInfo = {text: text.slice(0, 1000), rects: rects};
            }
            hlBtn.disabled = !(notesApi && notesReady && selInfo);
        }
        function addHighlight() {
            if (!selInfo || !notesReady) return;
            var now = new Date().toISOString();
            var h = {id: kpvId(), page: pageNum, rects: selInfo.rects, text: selInfo.text, note: '', created: now, updated: now};
            notesDoc.highlights.push(h);
            selInfo = null; hlBtn.disabled = true;
            var sel = window.getSelection(); if (sel) sel.removeAllRanges();
            drawHighlights(); scheduleSave(); refreshNotesList();
            openPopup(h);
        }
        function removeHighlight(h) {
            notesDoc.highlights = notesDoc.highlights.filter(function(x) { return x.id !== h.id; });
            notesDoc.removed.push({id: h.id, at: new Date().toISOString()});
            if (notesDoc.removed.length > 500) notesDoc.removed = notesDoc.removed.slice(-500);
            closePopup(); drawHighlights(); scheduleSave(); refreshNotesList();
        }
        function highlightAt(fx, fy) {
            var list = liveHighlights(), found = null;
            list.forEach(function(h) {
                if (h.page !== pageNum) return;
                h.rects.forEach(function(r) { if (fx >= r[0] && fx <= r[0] + r[2] && fy >= r[1] && fy <= r[1] + r[3]) found = h; });
            });
            return found;
        }
        function closePopup() {
            if (!popup) return;
            var p = popup; popup = null;
            if (p.commit) p.commit();
            if (p.node.parentNode) p.node.parentNode.removeChild(p.node);
        }
        function openPopup(h) {
            closePopup();
            var node = kpvEl('div', 'kpv-pop');
            node.setAttribute('data-role', 'note-popup');
            node.appendChild(kpvEl('small', null, '“' + h.text + '”'));
            var ta = kpvEl('textarea'); ta.value = h.note || ''; ta.placeholder = 'Add a note (optional)'; ta.maxLength = 4000;
            node.appendChild(ta);
            var row = kpvEl('div', 'kpv-pop-row');
            var del = kpvEl('button', 'del', 'Remove highlight'), done = kpvEl('button', 'go', 'Done');
            del.type = done.type = 'button';
            row.appendChild(del); row.appendChild(done); node.appendChild(row);
            ['mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'keypress', 'wheel', 'dblclick', 'contextmenu'].forEach(function(t) {
                node.addEventListener(t, function(e) { e.stopPropagation(); });
            });
            var committed = false;
            function commit() {
                if (committed) return; committed = true;
                var v = ta.value.trim();
                if (v !== (h.note || '')) { h.note = v; h.updated = new Date().toISOString(); drawHighlights(); scheduleSave(); refreshNotesList(); }
            }
            del.addEventListener('click', function() { committed = true; removeHighlight(h); });
            done.addEventListener('click', function() { closePopup(); });
            var r = h.rects[0];
            pageBox.appendChild(node);
            var w = pageBox.clientWidth, left = Math.max(4, Math.min(w - 248, r[0] * w));
            node.style.left = left + 'px';
            node.style.top = Math.min(pageBox.clientHeight - 10, (r[1] + r[3]) * pageBox.clientHeight + 6) + 'px';
            popup = {node: node, commit: commit, h: h};
            ta.focus();
        }
        function refreshNotesList() { if (tab === 'notes' && side.className.indexOf('open') >= 0) buildNotesList(); }
        function buildNotesList() {
            var pane = panes.notes; if (!pane) return;
            pane.textContent = '';
            var list = liveHighlights().slice().sort(function(a, b) { return a.page - b.page || a.rects[0][1] - b.rects[0][1]; });
            if (!list.length) { pane.appendChild(kpvEl('div', 'kpv-empty', 'Select some text on a page and press the highlighter to add a highlight.')); return; }
            list.forEach(function(h) {
                var card = kpvEl('div', 'kpv-note');
                card.setAttribute('data-hl', h.id);
                card.appendChild(kpvEl('b', null, 'Page ' + h.page));
                card.appendChild(kpvEl('span', null, h.text.length > 120 ? h.text.slice(0, 120) + '…' : h.text));
                if (h.note) card.appendChild(kpvEl('i', null, h.note));
                card.addEventListener('click', function() {
                    if (h.page !== pageNum) { goPage(h.page); var wait = setInterval(function() { if (!rendering) { clearInterval(wait); openPopup(h); } }, 60); setTimeout(function() { clearInterval(wait); }, 5000); }
                    else openPopup(h);
                });
                pane.appendChild(card);
            });
        }
        function loadNotes() {
            if (!notesApi) return;
            notesApi.load(function(err, doc) {
                if (err) { say('The notes could not be read: ' + (err.message || err), true); return; }
                if (doc && Array.isArray(doc.highlights)) notesDoc = {highlights: doc.highlights, removed: Array.isArray(doc.removed) ? doc.removed : []};
                notesReady = true;
                drawHighlights(); refreshNotesList(); readSelection();
            });
        }

        // ---- events ----------------------------------------------------------------------------------------------------------
        // Clicks and keys inside the viewer belong to the viewer, not to the morph under it; a Ctrl or Command press still goes through
        // (that is the halo).
        function mine(e) { return !(e.ctrlKey || e.metaKey); }
        ['mousedown', 'mouseup', 'dblclick'].forEach(function(t) {
            container.addEventListener(t, function(e) { if (mine(e)) e.stopPropagation(); });
        });
        ['keydown', 'keyup', 'keypress'].forEach(function(t) {
            container.addEventListener(t, function(e) { e.stopPropagation(); });
        });
        // A press and drag on the page is a selection of its text, not a move of the whole box: the world (which sees the press first, as
        // it listens while the event is still on its way down) has by now noted this box as the one pressed on, and would move it as soon
        // as the pointer travels a few pixels. Forget that for presses inside the page area; the toolbar still moves the box, and Ctrl (or
        // Command) + click still goes to the halo as before.
        view.addEventListener('pointerdown', function(e) {
            if (!mine(e) || e.button !== 0) return;
            var hand = e.hand || (window.$world && $world.firstHand && $world.firstHand());
            if (hand) hand.clickedOnMorph = null;
            if (window.$world) $world.clickedOnMorph = null;
        });
        // A button must not take the selection away from the text when it is pressed.
        bar.addEventListener('mousedown', function(e) { if (e.target.tagName !== 'SELECT') e.preventDefault(); });
        function on(btn, fn) { btn.addEventListener('click', function(e) { e.stopPropagation(); fn(e); }); }
        on(sideBtn, toggleSide);
        on(prevBtn, function() { goPage(pageNum - 1); });
        on(nextBtn, function() { goPage(pageNum + 1); });
        on(zoomOutBtn, function() { stepZoom(-1); });
        on(zoomInBtn, function() { stepZoom(1); });
        zoomSel.addEventListener('change', function() { setZoom(zoomSel.value); });
        on(findBtn, function() { if (findBar.className.indexOf('open') >= 0) closeFind(); else openFind(); });
        on(findClose, closeFind);
        on(hitPrev, function() { nextHit(-1); });
        on(hitNext, function() { nextHit(1); });
        on(caseBtn, function() { matchCase = !matchCase; caseBtn.className = 'kpv-btn kpv-txtbtn' + (matchCase ? ' on' : ''); runSearch(); });
        on(hlBtn, addHighlight);
        Object.keys(tabBtns).forEach(function(k) { on(tabBtns[k], function() { showTab(k); }); });
        findInput.addEventListener('input', function() { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); });
        findInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); if (findInput.value !== query) { clearTimeout(searchTimer); runSearch(); } else nextHit(e.shiftKey ? -1 : 1); }
            else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
        });
        // (Ctrl + wheel is NOT used for zoom here: the world takes it first, to zoom the whole world, before anything inside a box can.)
        // After a press and release on the page: a selection can be highlighted; a press on a highlight opens its note.
        view.addEventListener('mouseup', function(e) {
            if (!mine(e) || e.button !== 0) return;
            setTimeout(function() {
                readSelection();
                if (selInfo || popup && popup.node.contains(e.target)) return;
                var box = pageBox.getBoundingClientRect();
                if (!notesApi || !box.width || e.target.closest && e.target.closest('.kpv-pop')) return;
                var h = highlightAt((e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height);
                if (h) openPopup(h); else closePopup();
            }, 0);
        });
        document.addEventListener('selectionchange', function onSel() {
            if (!container.isConnected) { if (container.__kpvSeen) document.removeEventListener('selectionchange', onSel); return; }
            container.__kpvSeen = true;
            readSelection();
        });
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(function() {
                if (pdfDoc && lastAvail !== view.clientWidth + 'x' + view.clientHeight && (zoomMode === 'width' || zoomMode === 'page')) render();
            }).observe(view);
        }

        // ---- start -----------------------------------------------------------------------------------------------------------
        function initPDF() {
            var lib = window.pdfjsLib;
            if (!lib.GlobalWorkerOptions.workerSrc) {
                lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
            }
            var docParams = (urlOrBytes instanceof Uint8Array) ? { data: urlOrBytes } : urlOrBytes;
            lib.getDocument(docParams).promise.then(function(pdf) {
                pdfDoc = pdf;
                zoomSel.value = zoomMode;
                updateNav();
                render();
                loadNotes();
                if (side.className.indexOf('open') >= 0) showTab(tab);
            }).catch(function(e) {
                pageInfo.textContent = kpvLoadError(e);
                pageInfo.style.minWidth = '0'; pageInfo.style.textAlign = 'left';
            });
        }
        zoomSel.value = 'width';
        showTab('outline');
        updateNav();

        if (window.pdfjsLib) {
            initPDF();
        } else {
            var script = document.createElement('script');
            script.src = PDFJS_URL;
            script.onload = initPDF;
            // Blocked or unreachable (inside keo the world may load scripts from the package only): say so instead of "Loading…" for ever.
            script.onerror = function() { pageInfo.textContent = 'The PDF viewer could not be loaded.'; };
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
