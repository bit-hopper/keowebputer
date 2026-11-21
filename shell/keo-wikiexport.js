// Making a FILE out of a wiki page kept on this device, SHELL side: Markdown, or a standalone web page. Pure logic over the page's Yjs update
// (what keo-wikipages.js read hands over), so a Node test can run it. No DOM, no network, no Yjs beyond the vendored copy (keo-yjs.js).
//
// WHY HERE AND NOT IN THE WORLD. The world's frame may not start a download, and a file the person ends up with on their disk must not be
// something the world made up: the world only ASKS (`wiki.export`), and this file builds the bytes from the page the shell holds, as the
// download of a library file (keo-library.js fileSave) hands over bytes the library holds. The world is told the file's name and size, never
// the bytes.
//
// WHAT IS READ. The page's document is the editor's: an XML tree under the fragment `prosemirror` (the editor's schema: paragraph, heading,
// bullet and ordered lists, quote, code block, code cell, display math, a card for a shared link, video, audio, an embedded part; inline: text
// with marks, a break, inline math, an image), with the marks written as attributes of the text (bold, italic, code, underline, strike,
// superscript, subscript, colours, link). Anything this file does not know is written as the text it holds. A document is read with a budget
// (MAX_NODES) and containers nested deeper than MAX_DEPTH are written as plain text, so a page made to be hostile cannot exhaust memory or the
// stack. What a writer put in the page is untrusted: every character that could be markup is escaped, a link or an image is written only when
// its address is of a kind that is safe to open from a file (http, https, mailto; an image also as a small embedded picture), and the web page
// carries a policy that lets nothing run.
//
// WHAT IS NOT CARRIED. Not the formatting of the text beyond what Markdown and a plain page can say (font, size, alignment is kept in the web
// page only); not a video, a sound or an embedded part (they are named: their files are not in the page's document); not a card's picture. The
// math is written as its source (`$...$`), not drawn. Nothing in the file says who wrote the page or when: it is the page's text, not its history.
(function (root, factory) {
  var node = typeof module === 'object' && module.exports;
  var api = factory(node ? require('./keo-yjs.js') : root.keoYjs);
  if (node) module.exports = api; else root.keoWikiExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Y) {
  'use strict';

  var MAX_NODES = 200000, MAX_DEPTH = 40, MAX_OUT = 64 * 1024 * 1024;
  var FORMATS = { markdown: { ext: 'md', type: 'text/markdown;charset=utf-8' }, html: { ext: 'html', type: 'text/html;charset=utf-8' } };
  var MARKS = { bold: 1, italic: 1, code: 1, underline: 1, strike: 1, superscript: 1, subscript: 1, textColor: 1, backgroundColor: 1, link: 1 };

  // ---- reading the document ------------------------------------------------------------------------------------------------------
  function isText(n) { return n instanceof Y.XmlText; }
  function isElement(n) { return n instanceof Y.XmlElement; }

  // The text a node holds, without any structure and without recursion (a page can be nested as deep as a writer likes): blocks on lines.
  function plain(root, budget) {
    var out = [], stack = [{ list: [root], i: 0 }];
    while (stack.length && budget.n < MAX_NODES) {
      var top = stack[stack.length - 1];
      if (top.i >= top.list.length) { stack.pop(); if (stack.length) out.push('\n'); continue; }
      var n = top.list[top.i++];
      budget.n++;
      if (isText(n)) n.toDelta().forEach(function (op) { if (typeof op.insert === 'string') out.push(op.insert); });
      else if (isElement(n)) stack.push({ list: n.toArray(), i: 0 });
    }
    return out.join('').replace(/\n{2,}/g, '\n').trim();
  }

  function attr(n, name, fallback) { var v = n.getAttribute(name); return v === undefined || v === null ? fallback : v; }
  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : ''); }

  // The marks of a run of text: { bold: true, link: { href }, textColor: 'red' ... } from the attributes the editor writes (a mark that can
  // occur twice carries a suffix after `--`).
  function marksOf(attributes) {
    var m = {};
    Object.keys(attributes || {}).forEach(function (k) {
      var name = k.split('--')[0];
      if (!MARKS[name] || attributes[k] === null || attributes[k] === false) return;
      var v = attributes[k];
      if (name === 'link') m.link = { href: str(v && v.href) };
      else if (name === 'textColor' || name === 'backgroundColor') { if (v && typeof v.color === 'string') m[name] = v.color; }
      else m[name] = true;
    });
    return m;
  }
  function sameMarks(a, b) {
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) {
      var x = a[ka[i]], y = b[ka[i]];
      if (y === undefined) return false;
      if (typeof x === 'object' ? x.href !== y.href : x !== y) return false;
    }
    return true;
  }

  // The inline content of a text block: [{ t: 'text', s, marks } | { t: 'br' } | { t: 'math', value } | { t: 'img', src, alt }].
  function inlineOf(children, budget) {
    var out = [];
    children.forEach(function (c) {
      if (budget.n++ >= MAX_NODES) return;
      if (isText(c)) {
        c.toDelta().forEach(function (op) {
          if (typeof op.insert !== 'string' || !op.insert) return;
          var marks = marksOf(op.attributes), last = out[out.length - 1];
          if (last && last.t === 'text' && sameMarks(last.marks, marks)) last.s += op.insert; else out.push({ t: 'text', s: op.insert, marks: marks });
        });
      } else if (isElement(c)) {
        var name = c.nodeName;
        if (name === 'hard_break') out.push({ t: 'br' });
        else if (name === 'math_inline') out.push({ t: 'math', value: str(attr(c, 'value', '')) });
        else if (name === 'image') out.push({ t: 'img', src: str(attr(c, 'src', '')), alt: str(attr(c, 'alt', '')) });
        else { var p = plain(c, budget); if (p) out.push({ t: 'text', s: p, marks: {} }); }
      }
    });
    return out;
  }

  // Blocks: [{ t: 'p', align, indent, inl } | { t: 'h', level, inl } | { t: 'ul', items } | { t: 'ol', start, items } | { t: 'quote', blocks } |
  //          { t: 'code', lang, text } | { t: 'math', value } | { t: 'card', url, title, description } | { t: 'media', kind, name } | { t: 'part' } |
  //          { t: 'note', text }]; an item of a list is a list of blocks.
  function blocksOf(nodes, depth, budget) {
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      if (budget.n++ >= MAX_NODES) { out.push({ t: 'note', text: 'The rest of this page was too large to be put in the file.' }); break; }
      var n = nodes[i];
      if (isText(n)) { var s = plain(n, budget); if (s) out.push({ t: 'p', align: 'left', indent: 0, inl: [{ t: 'text', s: s, marks: {} }] }); continue; }
      if (!isElement(n)) continue;
      var name = n.nodeName;
      if (name === 'paragraph') out.push({ t: 'p', align: str(attr(n, 'align', 'left')), indent: Number(attr(n, 'indent', 0)) || 0, inl: inlineOf(n.toArray(), budget) });
      else if (name === 'heading') out.push({ t: 'h', level: Math.min(6, Math.max(1, parseInt(attr(n, 'level', 1), 10) || 1)), align: str(attr(n, 'align', 'left')), inl: inlineOf(n.toArray(), budget) });
      else if (name === 'bullet_list' || name === 'ordered_list') {
        if (depth >= MAX_DEPTH) { out.push({ t: 'p', align: 'left', indent: 0, inl: [{ t: 'text', s: plain(n, budget), marks: {} }] }); continue; }
        var items = n.toArray().filter(isElement).map(function (li) { return blocksOf(li.toArray(), depth + 1, budget); });
        if (name === 'bullet_list') out.push({ t: 'ul', items: items });
        else { var o = parseInt(attr(n, 'order', 1), 10); out.push({ t: 'ol', start: Number.isFinite(o) && o >= 0 && o < 1e9 ? o : 1, items: items }); }
      } else if (name === 'blockquote') {
        if (depth >= MAX_DEPTH) out.push({ t: 'p', align: 'left', indent: 0, inl: [{ t: 'text', s: plain(n, budget), marks: {} }] });
        else out.push({ t: 'quote', blocks: blocksOf(n.toArray(), depth + 1, budget) });
      } else if (name === 'code_block') out.push({ t: 'code', lang: '', text: plain(n, budget) });
      else if (name === 'code_cell') out.push({ t: 'code', lang: String(attr(n, 'language', '')).replace(/[^A-Za-z0-9_+#.-]/g, '').slice(0, 20), text: plain(n, budget) });
      else if (name === 'math_display') out.push({ t: 'math', value: str(attr(n, 'value', '')) });
      else if (name === 'link_preview_card') out.push({ t: 'card', url: str(attr(n, 'url', '')), title: str(attr(n, 'title', '')), description: str(attr(n, 'description', '')) });
      else if (name === 'video' || name === 'audio') out.push({ t: 'media', kind: name, name: str(attr(n, 'name', '')) });
      else if (name === 'embeddedPart') out.push({ t: 'part' });
      else { var p = plain(n, budget); if (p) out.push({ t: 'p', align: 'left', indent: 0, inl: [{ t: 'text', s: p, marks: {} }] }); }
    }
    return out;
  }

  function parse(update) {
    var doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    return blocksOf(doc.getXmlFragment('prosemirror').toArray(), 0, { n: 0 });
  }

  // ---- what may be written as an address -------------------------------------------------------------------------------------------
  function safeLink(href) { return /^(https?:\/\/|mailto:)[^\s\u0000-\u001f]*$/i.test(String(href || '').trim()) ? String(href).trim() : null; }
  function safeImage(src) { return /^(https?:\/\/[^\s\u0000-\u001f]*|data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]*)$/i.test(String(src || '').trim()) ? String(src).trim() : null; }
  function safeColor(c) { return /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgba?\([0-9., %]{3,40}\))$/.test(String(c || '')) ? String(c) : null; }

  // ---- Markdown --------------------------------------------------------------------------------------------------------------------
  function mdEscape(s) { return s.replace(/[\\`*_\[\]<>~&]/g, '\\$&'); }
  var URL_MAP = { ' ': '%20', '(': '%28', ')': '%29', '<': '%3C', '>': '%3E', '\n': '%0A', '\r': '%0D', '\\': '%5C' };
  function mdUrl(u) { return u.replace(/[ ()<>\n\r\\]/g, function (c) { return URL_MAP[c]; }); }
  function codeSpan(s) {
    var runs = s.match(/`+/g) || [], n = 1;
    while (runs.indexOf('`'.repeat(n)) >= 0) n++;
    var fence = '`'.repeat(n);
    return fence + (/^`|`$/.test(s) ? ' ' + s + ' ' : s) + fence;
  }
  // A line that would be read as a block (a heading, a list item, a rule) is written so that it is read as the text it is.
  function lineStart(line) {
    if (/^\d+[.)](\s|$)/.test(line)) return line.replace(/^(\d+)([.)])/, '$1\\$2');
    if (/^([#+\-=])/.test(line) && /^(#{1,6}(\s|$)|[+\-](\s|$)|=+\s*$|-+\s*$)/.test(line)) return '\\' + line;
    return line;
  }
  function mdRun(r) {
    var m = r.marks, s = r.s;
    var lead = (/^\s*/.exec(s) || [''])[0], trail = s.length > lead.length ? (/\s*$/.exec(s) || [''])[0] : '', core = s.slice(lead.length, s.length - trail.length);
    if (!core) return s;
    var t = m.code ? codeSpan(core) : mdEscape(core);
    if (m.strike) t = '~~' + t + '~~';
    if (m.bold && m.italic) t = '***' + t + '***'; else if (m.bold) t = '**' + t + '**'; else if (m.italic) t = '*' + t + '*';
    if (m.underline) t = '<u>' + t + '</u>';
    if (m.superscript) t = '<sup>' + t + '</sup>';
    if (m.subscript) t = '<sub>' + t + '</sub>';
    if (m.link) { var h = safeLink(m.link.href); if (h) t = '[' + t + '](' + mdUrl(h) + ')'; }
    return lead + t + trail;
  }
  function mdInline(inl) {
    var s = inl.map(function (x) {
      if (x.t === 'text') return mdRun(x);
      if (x.t === 'br') return '  \n';
      // between dollars where that is plain TeX; as a code span when the source holds anything a viewer could read as markup or HTML
      if (x.t === 'math') return /[$\n<>&`]/.test(x.value) ? codeSpan(x.value.replace(/\n/g, ' ')) : '$' + x.value + '$';
      if (x.t === 'img') { var u = safeImage(x.src); return u ? '![' + mdEscape(x.alt) + '](' + mdUrl(u) + ')' : (x.alt ? mdEscape('[picture: ' + x.alt + ']') : '[picture]'); }
      return '';
    }).join('');
    // each line starts at its first word (leading spaces would make a code block of it), and the end of the paragraph is not a break
    return s.split('\n').map(function (l) { return lineStart(l.replace(/^\s+/, '')); }).join('\n').replace(/\s+$/, '');
  }
  function fence(text, lang) {
    var runs = text.match(/`+/g) || [], n = 3;
    while (runs.some(function (r) { return r.length >= n; })) n++;
    var f = '`'.repeat(n);
    return [f + (lang || '')].concat(text.split('\n'), [f]);
  }
  // Lines of a list of blocks, one blank line between blocks (none before a list that follows a paragraph inside an item: `tight`).
  function mdBlocks(blocks, tight) {
    var lines = [], prev = null;
    blocks.forEach(function (b) {
      var l = mdBlock(b);
      if (!l.length) return;
      if (lines.length && !(tight && prev && prev.t === 'p' && (b.t === 'ul' || b.t === 'ol'))) lines.push('');
      lines = lines.concat(l);
      prev = b;
    });
    return lines;
  }
  function mdBlock(b) {
    if (b.t === 'p') { var s = mdInline(b.inl); return s.trim() ? s.split('\n') : []; }
    if (b.t === 'h') { var h = mdInline(b.inl).replace(/\s*\n\s*/g, ' ').trim(); return h ? ['#'.repeat(b.level) + ' ' + h.replace(/^\\(#)/, '$1')] : []; }
    if (b.t === 'ul' || b.t === 'ol') {
      var out = [];
      b.items.forEach(function (item, i) {
        var marker = b.t === 'ul' ? '- ' : (b.start + i) + '. ', inner = mdBlocks(item, true), pad = ' '.repeat(marker.length);
        if (!inner.length) { out.push(marker.trimEnd()); return; }
        inner.forEach(function (line, k) { out.push(k === 0 ? marker + line : (line ? pad + line : '')); });
      });
      return out;
    }
    if (b.t === 'quote') return mdBlocks(b.blocks, false).map(function (l) { return l ? '> ' + l : '>'; });
    if (b.t === 'code') return fence(b.text, b.lang);
    // a fenced block named math: a viewer that draws it does, and one that does not still shows the source as code; the source is never
    // read as markup or HTML, whatever it holds
    if (b.t === 'math') return fence(b.value, 'math');
    if (b.t === 'card') {
      var u = safeLink(b.url), title = (b.title || b.url).replace(/\s+/g, ' ');
      return [(u ? '[' + mdEscape(title) + '](' + mdUrl(u) + ')' : mdEscape(title)) + (b.description ? ' — ' + mdEscape(b.description.replace(/\s+/g, ' ')) : '')];
    }
    if (b.t === 'media') return ['*[' + b.kind + (b.name ? ': ' + mdEscape(b.name) : '') + ']*'];
    if (b.t === 'part') return ['*[embedded part]*'];
    if (b.t === 'note') return ['*' + mdEscape(b.text) + '*'];
    return [];
  }
  function toMarkdown(name, blocks) { return '# ' + mdEscape(name).replace(/\s+/g, ' ') + '\n\n' + mdBlocks(blocks, false).join('\n') + '\n'; }

  // ---- web page --------------------------------------------------------------------------------------------------------------------
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function htmlRun(r) {
    var m = r.marks, t = esc(r.s).replace(/\n/g, '<br>');
    if (m.code) t = '<code>' + t + '</code>';
    if (m.bold) t = '<strong>' + t + '</strong>';
    if (m.italic) t = '<em>' + t + '</em>';
    if (m.underline) t = '<u>' + t + '</u>';
    if (m.strike) t = '<s>' + t + '</s>';
    if (m.superscript) t = '<sup>' + t + '</sup>';
    if (m.subscript) t = '<sub>' + t + '</sub>';
    var css = [], c = safeColor(m.textColor), bg = safeColor(m.backgroundColor);
    if (c) css.push('color:' + c); if (bg) css.push('background-color:' + bg);
    if (css.length) t = '<span style="' + css.join(';') + '">' + t + '</span>';
    if (m.link) { var h = safeLink(m.link.href); if (h) t = '<a href="' + esc(h) + '" rel="noopener noreferrer">' + t + '</a>'; }
    return t;
  }
  function htmlInline(inl) {
    return inl.map(function (x) {
      if (x.t === 'text') return htmlRun(x);
      if (x.t === 'br') return '<br>';
      if (x.t === 'math') return '<code class="math-inline">' + esc(x.value) + '</code>';
      if (x.t === 'img') { var u = safeImage(x.src); return u ? '<img src="' + esc(u) + '" alt="' + esc(x.alt) + '">' : esc(x.alt ? '[picture: ' + x.alt + ']' : '[picture]'); }
      return '';
    }).join('');
  }
  var ALIGNS = { left: 1, center: 1, right: 1, justify: 1 };
  function style(b) {
    var css = [];
    if (ALIGNS[b.align] && b.align !== 'left') css.push('text-align:' + b.align);
    if (b.indent > 0 && b.indent <= 20) css.push('margin-left:' + (b.indent * 24) + 'px');
    return css.length ? ' style="' + css.join(';') + '"' : '';
  }
  function htmlBlocks(blocks) { return blocks.map(htmlBlock).filter(Boolean).join('\n'); }
  function htmlBlock(b) {
    if (b.t === 'p') { var s = htmlInline(b.inl); return s.replace(/<br>/g, '').trim() ? '<p' + style(b) + '>' + s + '</p>' : ''; }
    if (b.t === 'h') return '<h' + b.level + style(b) + '>' + htmlInline(b.inl) + '</h' + b.level + '>';
    if (b.t === 'ul' || b.t === 'ol') {
      var tag = b.t, start = b.t === 'ol' && b.start !== 1 ? ' start="' + b.start + '"' : '';
      return '<' + tag + start + '>' + b.items.map(function (it) { return '<li>' + htmlBlocks(it) + '</li>'; }).join('') + '</' + tag + '>';
    }
    if (b.t === 'quote') return '<blockquote>' + htmlBlocks(b.blocks) + '</blockquote>';
    if (b.t === 'code') return '<pre><code' + (b.lang ? ' class="language-' + esc(b.lang) + '"' : '') + '>' + esc(b.text) + '</code></pre>';
    if (b.t === 'math') return '<pre class="math-display">' + esc(b.value) + '</pre>';
    if (b.t === 'card') {
      var u = safeLink(b.url), title = esc((b.title || b.url).replace(/\s+/g, ' '));
      return '<p class="card">' + (u ? '<a href="' + esc(u) + '" rel="noopener noreferrer">' + title + '</a>' : title) + (b.description ? ' — ' + esc(b.description.replace(/\s+/g, ' ')) : '') + '</p>';
    }
    if (b.t === 'media') return '<p class="media"><em>[' + b.kind + (b.name ? ': ' + esc(b.name) : '') + ']</em></p>';
    if (b.t === 'part') return '<p class="media"><em>[embedded part]</em></p>';
    if (b.t === 'note') return '<p><em>' + esc(b.text) + '</em></p>';
    return '';
  }
  var CSS = 'body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#222;line-height:1.5}img{max-width:100%}' +
    'pre{background:#f6f6f6;padding:10px;overflow:auto}code{font-family:monospace}blockquote{margin-left:0;padding-left:14px;border-left:3px solid #ddd;color:#555}' +
    'pre.math-display,code.math-inline{color:#444}';
  // A policy that lets nothing run and nothing be fetched but pictures: the page's words are not code, whatever a writer put in them.
  var POLICY = "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'";
  function toHtml(name, blocks) {
    return '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + POLICY + '">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(name) + '</title><style>' + CSS + '</style></head>\n<body>\n' +
      '<h1>' + esc(name) + '</h1>\n' + htmlBlocks(blocks) + '\n</body></html>\n';
  }

  // ---- the file --------------------------------------------------------------------------------------------------------------------
  // A name for the file from the page's name: letters and digits, one dash between runs of anything else, never empty, never a name a
  // system keeps for itself.
  function fileName(pageName, ext) {
    var base = String(pageName || '').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
    if (!base) base = 'wiki-page';
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base += '-page';
    return base + '.' + ext;
  }

  // o: { name (the page's name), update (the page's Yjs update, bytes), format: 'markdown' | 'html' }.
  // Answers { name (the file's), type, bytes } or throws a sentence.
  function exportPage(o) {
    var f = o && typeof o.format === 'string' && Object.prototype.hasOwnProperty.call(FORMATS, o.format) ? FORMATS[o.format] : null;
    if (!f) throw new Error('A page can be saved as "markdown" or "html".');
    var update = o.update instanceof Uint8Array ? o.update : null;
    if (!update) throw new Error('There is no page to put in a file.');
    var blocks = parse(update), text = o.format === 'html' ? toHtml(String(o.name || ''), blocks) : toMarkdown(String(o.name || ''), blocks);
    var bytes = new TextEncoder().encode(text);
    if (bytes.length > MAX_OUT) throw new Error('This page is too large to be put in a file here.');
    return { name: fileName(o.name, f.ext), type: f.type, bytes: bytes };
  }

  return { exportPage: exportPage, parse: parse, toMarkdown: toMarkdown, toHtml: toHtml, fileName: fileName, FORMATS: FORMATS, MAX_NODES: MAX_NODES, MAX_DEPTH: MAX_DEPTH };
});
