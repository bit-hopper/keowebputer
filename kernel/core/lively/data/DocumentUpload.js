module('lively.data.DocumentUpload').requires('lively.data.FileUpload').toRun(function() {

// Documents other than PDF: markdown (.md), plain text (.txt), web pages (.html), books (.epub) and word-processor files (.docx).
// A document is shown in a box in the world, like a PDF; what it shows is made on this device from the file's bytes, with no network.
//
// Everything a document says is untrusted (an .html file or a book can hold scripts, styles and links to the network), so the text is
// never put into the world's own page. It is turned into a plain list of allowed tags (sanitize below: no scripts, no styles of its
// own, no links that go anywhere, no picture that is not inside the file), and then shown in an iframe with sandbox="" and a content
// security policy that allows only inline styling and pictures that are data: addresses. Two walls, so a mistake in one still leaves
// the other. Not for: anything that must run (a page that needs its scripts is not shown, by design).
//
// A .docx and an .epub are zip files. There is no zip library in the runtime: readZip below reads the directory of the archive and
// inflates an entry with the platform's DecompressionStream, with a size limit so a small file cannot expand into all the memory.

var W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
var MAX_ENTRY = 64 * 1024 * 1024;       // the most one entry of an archive may expand to
var MAX_IMAGE = 6 * 1024 * 1024;        // a picture inside a document bigger than this is left out
var MAX_IMAGES = 40;                    // pictures kept per page (a chapter, or the whole .docx)
var MAX_NODES = 300000;

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function decodeText(u8) {
    if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8.subarray(2));
    if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8.subarray(2));
    return new TextDecoder('utf-8').decode(u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF ? u8.subarray(3) : u8);
}

// ---- zip ---------------------------------------------------------------------------------------------------------------------------

function inflate(raw, limit) {
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('This browser cannot open this kind of file.'));
    var reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    var chunks = [], total = 0;
    function pump() {
        return reader.read().then(function(r) {
            if (r.done) {
                var out = new Uint8Array(total), at = 0;
                chunks.forEach(function(c) { out.set(c, at); at += c.length; });
                return out;
            }
            total += r.value.length;
            if (total > limit) { try { reader.cancel(); } catch (e) {} throw new Error('A part of this file is too large to open.'); }
            chunks.push(r.value);
            return pump();
        });
    }
    return pump();
}

// Reads the directory of a zip file. Returns { names: [..], has(name), read(name, limit) -> Promise<Uint8Array> }.
// Not supported (each says so): zip64, encryption, any compression but "stored" and "deflate".
function readZip(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This is not a valid zip-based file.');
    var count = dv.getUint16(eocd + 10, true), cdOff = dv.getUint32(eocd + 16, true);
    if (count === 0xFFFF || cdOff === 0xFFFFFFFF) throw new Error('This file is larger than keo can open (zip64).');
    var entries = {}, names = [], p = cdOff, td = new TextDecoder('utf-8');
    for (var n = 0; n < count; n++) {
        if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('This file is damaged (its list of parts cannot be read).');
        var flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
        var nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
        var name = td.decode(u8.subarray(p + 46, p + 46 + nl));
        entries[name] = { flags: flags, method: method, csize: csize, usize: usize, off: off };
        names.push(name);
        p += 46 + nl + el + cl;
    }
    return {
        names: names,
        has: function(name) { return Object.prototype.hasOwnProperty.call(entries, name); },
        read: function(name, limit) {
            if (!Object.prototype.hasOwnProperty.call(entries, name)) return Promise.reject(new Error('A part of this file is missing: ' + name));
            var e = entries[name];
            limit = limit || MAX_ENTRY;
            if (e.flags & 1) return Promise.reject(new Error('This file is protected with a password.'));
            if (e.csize === 0xFFFFFFFF || e.usize === 0xFFFFFFFF) return Promise.reject(new Error('This file is larger than keo can open (zip64).'));
            if (e.usize > limit) return Promise.reject(new Error('A part of this file is too large to open.'));
            if (e.off + 30 > u8.length || dv.getUint32(e.off, true) !== 0x04034b50) return Promise.reject(new Error('This file is damaged (a part cannot be found).'));
            var start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
            if (start + e.csize > u8.length) return Promise.reject(new Error('This file is damaged (a part is cut short).'));
            var raw = u8.subarray(start, start + e.csize);
            if (e.method === 0) return Promise.resolve(raw);
            if (e.method === 8) return inflate(raw, limit);
            return Promise.reject(new Error('This file uses a kind of packing keo cannot open.'));
        }
    };
}

// "OEBPS/text/ch1.xhtml" + "../images/a%20b.png#x" -> "OEBPS/images/a b.png"
function resolvePath(baseFile, href) {
    href = String(href || '').replace(/[#?].*$/, '');
    try { href = decodeURIComponent(href); } catch (e) { /* keep as it is */ }
    var parts = href.charAt(0) === '/' ? [] : baseFile.split('/').slice(0, -1);
    href.split('/').forEach(function(seg) {
        if (seg === '..') parts.pop();
        else if (seg !== '.' && seg !== '') parts.push(seg);
    });
    return parts.join('/');
}

function imageTypeOf(name) {
    var m = /\.([A-Za-z0-9]+)$/.exec(name);
    return m && { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[m[1].toLowerCase()] || null;
}

function toDataUrl(u8, type) {
    return new Promise(function(resolve, reject) {
        var fr = new FileReader();
        fr.onload = function() { resolve(fr.result); };
        fr.onerror = function() { reject(fr.error); };
        fr.readAsDataURL(new Blob([u8], { type: type }));
    });
}

// Reads the pictures named in `paths` ({ key: zip path }) out of the archive: Promise<{ key: data: address }>. A picture that is
// missing, too big or not a picture is left out (the page then shows its description, if it has one).
function loadImages(zip, paths) {
    var keys = Object.keys(paths).slice(0, MAX_IMAGES), out = {};
    return keys.reduce(function(chain, key) {
        return chain.then(function() {
            var path = paths[key], type = imageTypeOf(path);
            if (!type || !zip.has(path)) return null;
            return zip.read(path, MAX_IMAGE).then(function(u8) { return toDataUrl(u8, type); }).then(function(url) { out[key] = url; }, function() { /* left out */ });
        });
    }, Promise.resolve()).then(function() { return out; });
}

// ---- the allowed tags ----------------------------------------------------------------------------------------------------------------

var KEEP = {};
('h1 h2 h3 h4 h5 h6 p br hr div span section article header footer main aside blockquote pre code em strong b i u s del ins sub sup small mark ' +
 'ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col a img figure figcaption cite q abbr details summary center').split(' ')
    .forEach(function(t) { KEEP[t] = true; });
// dropped together with everything inside them
var DROP = {};
('script style iframe frame frameset object embed link meta noscript template head title svg math canvas audio video source track applet ' +
 'form input button select textarea option base param').split(' ').forEach(function(t) { DROP[t] = true; });
var CLASSES = { center: 1, right: 1, justify: 1, title: 1, subtitle: 1, quote: 1 };

function sanitizeInto(src, dst, out, ctx, depth) {
    for (var node = src.firstChild; node; node = node.nextSibling) {
        if (++ctx.count > MAX_NODES) return;
        if (node.nodeType === 3) { dst.appendChild(out.createTextNode(node.nodeValue)); continue; }
        if (node.nodeType !== 1) continue;
        var tag = node.localName.toLowerCase();
        if (DROP[tag]) continue;
        if (depth > 150) { dst.appendChild(out.createTextNode(node.textContent)); continue; }
        if (!KEEP[tag]) { sanitizeInto(node, dst, out, ctx, depth + 1); continue; }     // an unknown tag: its content stays
        if (tag === 'center') tag = 'div';
        var el, attr = function(n) { return node.getAttribute(n); };
        if (tag === 'img') {
            var url = ctx.image(attr('src'));
            if (!url) { var alt = attr('alt'); if (alt) { var sp = out.createElement('span'); sp.setAttribute('class', 'gone'); sp.textContent = '[' + alt.slice(0, 200) + ']'; dst.appendChild(sp); } continue; }
            el = out.createElement('img');
            el.setAttribute('src', url);
            if (attr('alt')) el.setAttribute('alt', attr('alt').slice(0, 300));
        } else {
            el = out.createElement(tag);
            if (tag === 'a') {
                var href = attr('href') || '';
                if (/^#[^\s]{0,200}$/.test(href)) el.setAttribute('href', href);
                else if (/^(https?:|mailto:)/i.test(href)) { el.setAttribute('class', 'ext'); el.setAttribute('title', href.slice(0, 300)); }    // shown, never followed
            }
            if ((tag === 'td' || tag === 'th')) {
                ['colspan', 'rowspan'].forEach(function(a) { var v = parseInt(attr(a), 10); if (v > 1 && v <= 1000) el.setAttribute(a, v); });
            }
            if (tag === 'ol') { var st = parseInt(attr('start'), 10); if (st >= 0 && st < 100000) el.setAttribute('start', st); }
        }
        var id = attr('id');
        if (id && /^[A-Za-z0-9_:.\-]{1,100}$/.test(id)) el.setAttribute('id', id);
        var cls = (attr('class') || '').trim().split(/\s+/);
        if (cls.length && cls.every(function(c) { return CLASSES[c]; }) && cls[0]) el.setAttribute('class', cls.join(' '));
        var title = attr('title');
        if (title && tag !== 'a') el.setAttribute('title', title.slice(0, 300));
        dst.appendChild(el);
        if (tag !== 'img') sanitizeInto(node, el, out, ctx, depth + 1);
    }
}

// `html`: a piece of web page as text. `images`: { address as written in the page: data: address } of the pictures that may be shown;
// a data: picture written in the page itself is allowed when it is an ordinary picture kind. Returns the clean body as text.
function sanitize(html, images) {
    var parsed = new DOMParser().parseFromString(String(html), 'text/html');       // an inert document: nothing in it runs or loads
    var out = document.implementation.createHTMLDocument('');
    var ctx = {
        count: 0,
        image: function(src) {
            src = String(src || '');
            if (images && Object.prototype.hasOwnProperty.call(images, src)) return images[src];
            return /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+\/=]+$/i.test(src) ? src : null;
        }
    };
    sanitizeInto(parsed.body || parsed.documentElement, out.body, out, ctx, 0);
    return out.body.innerHTML;
}

// the addresses of the pictures a piece of web page asks for, for loadImages
function imageSources(html) {
    var parsed = new DOMParser().parseFromString(String(html), 'text/html'), list = [];
    Array.prototype.forEach.call(parsed.querySelectorAll('img[src]'), function(i) { list.push(i.getAttribute('src')); });
    return list;
}

// ---- one kind at a time ------------------------------------------------------------------------------------------------------------

function loadMarked(thenDo) {
    if (window.marked) return thenDo(null);
    var s = document.createElement('script');
    s.src = Config.codeBase + 'lib/marked/marked.js';
    s.onload = function() { thenDo(window.marked ? null : new Error('The markdown reader could not be loaded.')); };
    s.onerror = function() { thenDo(new Error('The markdown reader could not be loaded.')); };
    document.head.appendChild(s);
}

function xml(text) {
    var d = new DOMParser().parseFromString(text, 'application/xml');
    if (d.getElementsByTagName('parsererror').length) throw new Error('This file is damaged (a part is not valid).');
    return d;
}
function kids(el, local) { return Array.prototype.filter.call(el.childNodes, function(c) { return c.nodeType === 1 && c.localName === local; }); }
function wattr(el, name) { return el && (el.getAttributeNS(W, name) || el.getAttribute('w:' + name)); }
function on(el, flagLocal) {       // a switch like <w:b/> or <w:b w:val="false"/>
    var f = kids(el, flagLocal)[0];
    if (!f) return false;
    var v = wattr(f, 'val');
    return !(v === '0' || v === 'false' || v === 'off');
}

// -- epub: the book's spine and its table of contents
function openEpub(zip) {
    return zip.read('META-INF/container.xml', 1 << 20).then(function(c) {
        var root = xml(decodeText(c)).getElementsByTagName('rootfile')[0];
        var opfPath = root && root.getAttribute('full-path');
        if (!opfPath) throw new Error('This is not a valid book (it names no contents file).');
        return zip.read(opfPath, 8 << 20).then(function(o) {
            var opf = xml(decodeText(o)), manifest = {}, nav = null, ncx = null;
            Array.prototype.forEach.call(opf.getElementsByTagName('item'), function(it) {
                var m = { href: it.getAttribute('href'), type: it.getAttribute('media-type'), props: it.getAttribute('properties') || '' };
                manifest[it.getAttribute('id')] = m;
                if (/(^|\s)nav(\s|$)/.test(m.props)) nav = resolvePath(opfPath, m.href);
            });
            var spineEl = opf.getElementsByTagName('spine')[0], tocId = spineEl && spineEl.getAttribute('toc');
            if (tocId && manifest[tocId]) ncx = resolvePath(opfPath, manifest[tocId].href);
            var chapters = [];
            Array.prototype.forEach.call(opf.getElementsByTagName('itemref'), function(r) {
                var m = manifest[r.getAttribute('idref')];
                if (m && /html|xml/.test(m.type || '')) chapters.push({ path: resolvePath(opfPath, m.href), label: '' });
            });
            if (!chapters.length) throw new Error('This book has nothing to read in it.');
            var t = opf.getElementsByTagName('dc:title')[0] || opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0];
            var book = { title: t ? t.textContent.trim() : '', chapters: chapters };
            function labels(map) { chapters.forEach(function(ch, i) { ch.label = map[ch.path] || ''; if (!ch.label) ch.label = 'Part ' + (i + 1); }); return book; }
            if (nav && zip.has(nav)) {
                return zip.read(nav, 4 << 20).then(function(n) {
                    var d = new DOMParser().parseFromString(decodeText(n), 'text/html'), map = {};
                    Array.prototype.forEach.call(d.querySelectorAll('nav a[href]'), function(a) {
                        var p = resolvePath(nav, a.getAttribute('href'));
                        if (!map[p]) map[p] = a.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
                    });
                    return labels(map);
                }, function() { return labels({}); });
            }
            if (ncx && zip.has(ncx)) {
                return zip.read(ncx, 4 << 20).then(function(n) {
                    var d = xml(decodeText(n)), map = {};
                    Array.prototype.forEach.call(d.getElementsByTagName('navPoint'), function(np) {
                        var txt = np.getElementsByTagName('text')[0], con = np.getElementsByTagName('content')[0];
                        if (!txt || !con) return;
                        var p = resolvePath(ncx, con.getAttribute('src'));
                        if (!map[p]) map[p] = txt.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
                    });
                    return labels(map);
                }, function() { return labels({}); });
            }
            return labels({});
        });
    });
}

function epubChapter(zip, book, i) {
    var ch = book.chapters[i];
    return zip.read(ch.path, 16 << 20).then(function(u8) {
        var html = decodeText(u8), paths = {};
        imageSources(html).forEach(function(src) { if (!/^data:/i.test(src)) paths[src] = resolvePath(ch.path, src); });
        return loadImages(zip, paths).then(function(images) { return sanitize(html, images); });
    });
}

// -- docx
function docxToHtml(zip) {
    var parts = {};
    function part(name, limit) { return zip.has(name) ? zip.read(name, limit).then(function(u) { parts[name] = xml(decodeText(u)); }) : Promise.resolve(); }
    return Promise.resolve().then(function() {
        if (!zip.has('word/document.xml')) throw new Error('This is not a valid word-processor file (it has no text in it).');
        return part('word/document.xml', 48 << 20);
    }).then(function() { return part('word/styles.xml', 8 << 20); })
      .then(function() { return part('word/numbering.xml', 4 << 20); })
      .then(function() { return part('word/_rels/document.xml.rels', 1 << 20); })
      .then(function() {
        var doc = parts['word/document.xml'], styles = {}, nums = {}, abstract = {}, rels = {};
        if (parts['word/styles.xml']) Array.prototype.forEach.call(parts['word/styles.xml'].getElementsByTagNameNS(W, 'style'), function(s) {
            var nm = kids(s, 'name')[0];
            styles[wattr(s, 'styleId')] = nm ? String(wattr(nm, 'val')).toLowerCase() : '';
        });
        if (parts['word/numbering.xml']) {
            var nx = parts['word/numbering.xml'];
            Array.prototype.forEach.call(nx.getElementsByTagNameNS(W, 'abstractNum'), function(a) {
                var levels = {};
                kids(a, 'lvl').forEach(function(l) { var f = kids(l, 'numFmt')[0]; levels[wattr(l, 'ilvl')] = f ? wattr(f, 'val') : 'decimal'; });
                abstract[wattr(a, 'abstractNumId')] = levels;
            });
            Array.prototype.forEach.call(nx.getElementsByTagNameNS(W, 'num'), function(n) {
                var a = kids(n, 'abstractNumId')[0];
                if (a) nums[wattr(n, 'numId')] = wattr(a, 'val');
            });
        }
        if (parts['word/_rels/document.xml.rels']) Array.prototype.forEach.call(parts['word/_rels/document.xml.rels'].getElementsByTagName('Relationship'), function(r) {
            rels[r.getAttribute('Id')] = r.getAttribute('Target');
        });
        // the pictures first (reading them is the only part that waits), then the text is made in one go
        var want = {};
        Array.prototype.forEach.call(doc.getElementsByTagName('*'), function(e) {
            if (e.localName !== 'blip') return;
            var id = e.getAttribute('r:embed') || e.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
            if (id && rels[id] && !/^[a-z]+:/i.test(rels[id])) want[id] = resolvePath('word/document.xml', rels[id]);
        });
        return loadImages(zip, want).then(function(images) {
            var html = [], listStack = [], counters = {};
            function closeLists(toLevel) {
                while (listStack.length > toLevel) { html.push('</li></' + listStack.pop().tag + '>'); }
            }
            function isBullet(numId, lvl) {
                var levels = abstract[nums[numId]], f = levels && levels[lvl];
                return !f || f === 'bullet' || f === 'none';
            }
            function runHtml(r) {
                var rp = kids(r, 'rPr')[0], out = '';
                r.childNodes.forEach(function(c) {
                    if (c.nodeType !== 1) return;
                    if (c.localName === 't') out += esc(c.textContent);
                    else if (c.localName === 'tab') out += '&emsp;';
                    else if (c.localName === 'br' || c.localName === 'cr') out += wattr(c, 'type') === 'page' ? '<hr>' : '<br>';
                    else if (c.localName === 'noBreakHyphen') out += '-';
                    else if (c.localName === 'drawing') {
                        Array.prototype.forEach.call(c.getElementsByTagName('*'), function(b) {
                            if (b.localName !== 'blip') return;
                            var id = b.getAttribute('r:embed') || b.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
                            if (images[id]) out += '<img src="' + images[id] + '" alt="">';
                        });
                    }
                });
                if (!out) return '';
                if (rp) {
                    if (on(rp, 'b')) out = '<strong>' + out + '</strong>';
                    if (on(rp, 'i')) out = '<em>' + out + '</em>';
                    var u = kids(rp, 'u')[0];
                    if (u && wattr(u, 'val') !== 'none') out = '<u>' + out + '</u>';
                    if (on(rp, 'strike') || on(rp, 'dstrike')) out = '<s>' + out + '</s>';
                    var va = kids(rp, 'vertAlign')[0];
                    if (va && wattr(va, 'val') === 'superscript') out = '<sup>' + out + '</sup>';
                    if (va && wattr(va, 'val') === 'subscript') out = '<sub>' + out + '</sub>';
                }
                return out;
            }
            function inlineHtml(p) {
                var out = '';
                p.childNodes.forEach(function(c) {
                    if (c.nodeType !== 1) return;
                    if (c.localName === 'r') out += runHtml(c);
                    else if (c.localName === 'hyperlink' || c.localName === 'ins' || c.localName === 'smartTag' || c.localName === 'sdt' || c.localName === 'sdtContent' || c.localName === 'fldSimple') out += inlineHtml(c);
                });
                return out;
            }
            function paragraph(p) {
                var pp = kids(p, 'pPr')[0], style = '', numId = null, lvl = '0', align = '';
                if (pp) {
                    var ps = kids(pp, 'pStyle')[0];
                    style = ps ? (styles[wattr(ps, 'val')] || String(wattr(ps, 'val')).toLowerCase()) : '';
                    var np = kids(pp, 'numPr')[0];
                    if (np) { var ni = kids(np, 'numId')[0], il = kids(np, 'ilvl')[0]; numId = ni ? wattr(ni, 'val') : null; lvl = il ? wattr(il, 'val') : '0'; }
                    var jc = kids(pp, 'jc')[0];
                    align = jc ? { center: 'center', right: 'right', both: 'justify', end: 'right' }[wattr(jc, 'val')] || '' : '';
                }
                var inner = inlineHtml(p), head = /^heading ?(\d)/.exec(style);
                if (numId && numId !== '0' && !head) {
                    var level = Math.min(parseInt(lvl, 10) || 0, 8), bullet = isBullet(numId, lvl);
                    closeLists(level + 1);                                                  // a deeper list ends here
                    if (listStack.length === level + 1 && listStack[level].numId !== numId) closeLists(level);      // another list takes this place
                    if (listStack.length === level + 1) html.push('</li><li>');             // the next item of the list that is open
                    while (listStack.length < level + 1) {                                  // open the lists down to this level
                        var depth = listStack.length, k = numId + ':' + depth, first = bullet ? 0 : (counters[k] || 0) + 1;
                        listStack.push({ tag: bullet ? 'ul' : 'ol', numId: numId });
                        html.push('<' + (bullet ? 'ul' : 'ol') + (first > 1 ? ' start="' + first + '"' : '') + '><li>');
                    }
                    counters[numId + ':' + level] = (counters[numId + ':' + level] || 0) + 1;
                    html.push(inner || '&nbsp;');
                    return;
                }
                closeLists(0);
                if (!inner && !head) { html.push('<p>&nbsp;</p>'); return; }
                if (head) { var n = Math.min(6, parseInt(head[1], 10)); html.push('<h' + n + (align ? ' class="' + align + '"' : '') + '>' + inner + '</h' + n + '>'); return; }
                if (style === 'title') { html.push('<h1 class="title">' + inner + '</h1>'); return; }
                if (style === 'subtitle') { html.push('<p class="subtitle">' + inner + '</p>'); return; }
                if (/^(quote|intense quote)$/.test(style)) { html.push('<blockquote>' + inner + '</blockquote>'); return; }
                html.push('<p' + (align ? ' class="' + align + '"' : '') + '>' + inner + '</p>');
            }
            function block(parent) {
                parent.childNodes.forEach(function(c) {
                    if (c.nodeType !== 1) return;
                    if (c.localName === 'p') paragraph(c);
                    else if (c.localName === 'tbl') table(c);
                    else if (c.localName === 'sdt') { var sc = kids(c, 'sdtContent')[0]; if (sc) block(sc); }
                });
            }
            function table(t) {
                closeLists(0);
                html.push('<table>');
                kids(t, 'tr').forEach(function(tr) {
                    html.push('<tr>');
                    kids(tr, 'tc').forEach(function(tc) {
                        var tp = kids(tc, 'tcPr')[0], gs = tp && kids(tp, 'gridSpan')[0], span = gs ? parseInt(wattr(gs, 'val'), 10) : 1;
                        html.push('<td' + (span > 1 ? ' colspan="' + span + '"' : '') + '>');
                        block(tc);
                        closeLists(0);
                        html.push('</td>');
                    });
                    html.push('</tr>');
                });
                html.push('</table>');
            }
            var body = doc.getElementsByTagNameNS(W, 'body')[0];
            if (!body) throw new Error('This is not a valid word-processor file (it has no text in it).');
            block(body);
            closeLists(0);
            return sanitize(html.join(''), images);
        });
    });
}

// ---- the viewer --------------------------------------------------------------------------------------------------------------------

var STYLE =
    'html{background:#fff}body{margin:0;padding:18px 22px 40px;color:#1d1d1f;font:%SIZE%%/1.6 Georgia,"Times New Roman",serif;overflow-wrap:anywhere}' +
    '.page{max-width:46em;margin:0 auto}' +
    'h1,h2,h3,h4,h5,h6{font-family:Arial,Helvetica,sans-serif;line-height:1.25;margin:1.4em 0 .5em}h1{font-size:1.7em}h2{font-size:1.4em}h3{font-size:1.2em}h4,h5,h6{font-size:1em}' +
    'h1.title{text-align:center}.subtitle{text-align:center;color:#555;font-style:italic}.center{text-align:center}.right{text-align:right}.justify{text-align:justify}' +
    'p{margin:.7em 0}img{max-width:100%;height:auto}a{color:#1d4ed8}a.ext{text-decoration:underline dotted;cursor:default}.gone{color:#777;font-style:italic}' +
    'pre,code{font-family:Consolas,"Courier New",monospace;font-size:.92em}pre{background:#f5f5f7;padding:10px 12px;overflow:auto;border-radius:6px}code{background:#f5f5f7;padding:0 .25em;border-radius:3px}pre code{background:none;padding:0}' +
    'pre.plain{background:none;padding:0;white-space:pre-wrap;font-size:.95em;line-height:1.55}' +
    'blockquote{margin:.9em 0;padding:.1em 1em;border-left:4px solid #bfdbfe;color:#444}' +
    'table{border-collapse:collapse;margin:1em 0;max-width:100%}td,th{border:1px solid #ccc;padding:4px 8px;vertical-align:top}th{background:#f5f5f7}' +
    'hr{border:0;border-top:1px solid #ddd;margin:1.5em 0}';

function pageHtml(body, size) {
    return '<!doctype html><html><head><meta charset="utf-8">' +
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">' +
        '<style>' + STYLE.replace('%SIZE%%', size + '%') + '</style></head><body><div class="page">' + body + '</div></body></html>';
}

var MESSAGES = { loading: 'Loading…' };

// Factored out like buildPDFContainer, so lively.data.EncryptedMedia's EncryptedDocument rebuilds the identical viewer on a fresh
// drop and on a restored world. `bytes`: a Uint8Array. `info`: { type, name }. Returns the container node, which fills itself in.
Object.extend(lively.data.FileUpload, {
    buildDocumentContainer: function(bytes, info) {
        info = info || {};
        var type = info.type || '', size = 100, state = { render: null };

        var frame = document.createElement('iframe');
        frame.setAttribute('sandbox', '');            // no scripts, no forms, no popups, no same-origin: it can show and nothing else
        frame.setAttribute('title', info.name || 'document');
        frame.style.cssText = 'flex:1;border:0;width:100%;background:#fff;min-height:0';

        function button(text, title) {
            var b = document.createElement('button');
            b.textContent = text; b.title = title;
            b.addEventListener('mousedown', function(e) { e.stopPropagation(); });
            return b;
        }
        var prev = button('‹ Prev', 'Previous part'), next = button('Next ›', 'Next part');
        var pick = document.createElement('select'); pick.style.cssText = 'max-width:55%;margin:0 6px';
        var smaller = button('A−', 'Smaller text'), bigger = button('A+', 'Larger text');
        var label = document.createElement('span');
        label.style.cssText = 'font:12px Arial,sans-serif;margin:0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%';
        label.textContent = MESSAGES.loading;
        var left = document.createElement('div'); left.style.cssText = 'display:flex;align-items:center;min-width:0;flex:1';
        var right = document.createElement('div'); right.style.cssText = 'display:flex;align-items:center;flex-shrink:0';
        left.appendChild(label); right.appendChild(smaller); right.appendChild(bigger);
        var bar = document.createElement('div');
        bar.style.cssText = 'display:flex;align-items:center;padding:4px 8px;background:rgba(60,60,60,0.1);border-bottom:1px solid rgba(0,0,0,0.15);flex-shrink:0';
        bar.appendChild(left); bar.appendChild(right);

        var container = document.createElement('div');
        container.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;background:#fff';
        container.appendChild(bar); container.appendChild(frame);

        var bodyHtml = '';
        function show(body) { bodyHtml = body; frame.srcdoc = pageHtml(body, size); }
        function failed(err) { label.textContent = 'This document could not be opened.'; show('<p>' + esc(String(err && err.message || err)) + '</p>'); }
        function stop(btn, fn) { btn.addEventListener('click', function(e) { e.stopPropagation(); fn(); }); }
        stop(smaller, function() { size = Math.max(60, size - 10); if (bodyHtml) show(bodyHtml); });
        stop(bigger, function() { size = Math.min(240, size + 10); if (bodyHtml) show(bodyHtml); });

        function plain(text) { label.textContent = info.name || ''; show('<pre class="plain">' + esc(text) + '</pre>'); }
        function simple(body) { label.textContent = info.name || ''; show(body); }

        try {
            if (type === 'text/plain') plain(decodeText(bytes));
            else if (type === 'text/html') simple(sanitize(decodeText(bytes), null));
            else if (type === 'text/markdown') {
                loadMarked(function(err) {
                    if (err) return failed(err);
                    try { simple(sanitize(window.marked(decodeText(bytes)), null)); } catch (e) { failed(e); }
                });
            } else if (/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/.test(type)) {
                docxToHtml(readZip(bytes)).then(simple, failed);
            } else if (type === 'application/epub+zip') {
                var zip = readZip(bytes);
                openEpub(zip).then(function(book) {
                    var at = 0;
                    book.chapters.forEach(function(ch, i) {
                        var o = document.createElement('option'); o.value = i; o.textContent = ch.label; pick.appendChild(o);
                    });
                    left.removeChild(label);
                    left.appendChild(prev); left.appendChild(pick); left.appendChild(next);
                    function go(i) {
                        at = Math.max(0, Math.min(book.chapters.length - 1, i));
                        pick.value = String(at);
                        prev.disabled = at === 0; next.disabled = at === book.chapters.length - 1;
                        epubChapter(zip, book, at).then(show, failed);
                    }
                    stop(prev, function() { go(at - 1); }); stop(next, function() { go(at + 1); });
                    pick.addEventListener('change', function() { go(parseInt(pick.value, 10)); });
                    pick.addEventListener('mousedown', function(e) { e.stopPropagation(); });
                    go(0);
                }).catch(failed);
            } else failed(new Error('keo cannot show this kind of file yet (' + (type || 'unknown') + ').'));
        } catch (e) { failed(e); }
        return container;
    },
});

lively.data.FileUpload.Handler.subclass('lively.data.DocumentUpload.Handler', {
    // By the ending of the name (a browser often gives these files no type at all), or by a type the library knows. Only where the
    // file can be kept (the library on this device, or a host the person is signed in to): otherwise a text file keeps opening in a
    // plain text window, as before.
    handles: function(file) {
        var lf = lively.identity && lively.identity.localFiles;
        if (!lf || !file) return false;
        if (!(lf.docTypeOf(file.name) || lf.isDocType(file.type))) return false;
        return this.isIdentityUploadAvailable();
    },

    getUploadSpec: function(evt, file) { return { readMethod: 'manual' }; },

    readManually: function(file) {
        var self = this, lf = lively.identity.localFiles;
        self.identityUpload(file, function(err, ref) {
            if (err) { $world.inform('Error uploading document:\n' + err); return; }
            var morph = self.openDocument(ref, lf.docTypeOf(file.name) || file.type, file.name, self.pos);
            self.attachIdentityDelete(morph, { handle: ref.handle, blobCid: ref.blobCid });
        });
    },

    // ref: {handle, objId}, as for a PDF
    openDocument: function(ref, mime, name, pos) {
        var morph = new lively.data.FileUpload.EncryptedDocument(ref, mime, name);
        morph.openInWorld(pos);
        morph._rebuildContent();
        return morph;
    },
});

}) // end of module
