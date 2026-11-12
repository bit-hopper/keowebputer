// What can be searched in a saved world, and the search itself. No storage, no DOM, no keys: pure functions, so a Node test can check
// them. keo-worlds.js keeps the text this module extracts inside the same encryption as the world it came from.
//
// extract(doc)   the readable text of a saved page: the strings the person typed into the world's text morphs and the names of
//                its morphs, taken from the world's serialized data (the script element of type text/x-lively-world). Not the
//                markup, the styles, the code of the runtime or the numbers: those would match almost any query. A page with no
//                such element, or with data that is not valid JSON, gives ''.
// search(entries, query)   entries are { name, tags, note, text }; the query is words (all of them must be found) and "quoted
//                phrases". Case and accents do not matter. Names rank above tags, tags above the note, the note above the body.
//
// Not here: stemming, typo tolerance and ranking by how often a word occurs beyond a small cap. It is a find-it-again search over
// one person's own worlds, not a search engine.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.keoWorldText = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Keys of the runtime's serialized objects that hold text a person wrote or named. `storedString` is what a text morph and each of
  // its chunks keep of the typed text; `name` is a morph's name.
  var TEXT_KEYS = { storedString: 1, textString: 1, name: 1 };
  var MAX_CHARS = 256 * 1024;         // what is kept per world; a guard against a runaway world, not a quota
  var SCRIPT = /<script\b[^>]*\btype\s*=\s*["']text\/x-lively-world["'][^>]*>([\s\S]*?)<\/script>/i;

  // The library files a saved page shows: the ids of the objects in its registry that hold { fileHandle: 'keo:local', fileObjId: <id> }
  // (a picture, video, sound, PDF or document morph that was placed from the library). Read from the data, never by searching the page's
  // text: the same id also appears in the markup and state of an open My files window, which is not a use. Sorted, each id once, at most
  // MAX_FILES; a page with no world data, or data that is not valid, gives [].
  var FILE_ID = /^[A-Za-z0-9_-]{43}$/;
  var MAX_FILES = 5000;
  function fileIds(doc) {
    var m = SCRIPT.exec(String(doc == null ? '' : doc));
    if (!m) return [];
    var data;
    try { data = JSON.parse(m[1]); } catch (e) { return []; }
    var reg = data && data.registry;
    if (!reg || typeof reg !== 'object') return [];
    var out = [], seen = Object.create(null);
    Object.keys(reg).forEach(function (k) {
      var o = reg[k];
      if (!o || typeof o !== 'object' || o.fileHandle !== 'keo:local' || typeof o.fileObjId !== 'string') return;
      if (!FILE_ID.test(o.fileObjId) || seen[o.fileObjId] || out.length >= MAX_FILES) return;
      seen[o.fileObjId] = 1;
      out.push(o.fileObjId);
    });
    return out.sort();
  }

  function extract(doc, maxChars) {
    var limit = maxChars || MAX_CHARS, m = SCRIPT.exec(String(doc == null ? '' : doc));
    if (!m) return '';
    var data;
    try { data = JSON.parse(m[1]); } catch (e) { return ''; }
    var reg = data && data.registry;
    if (!reg || typeof reg !== 'object') return '';
    var out = [], size = 0, seen = Object.create(null);
    function add(v) {
      if (typeof v !== 'string') return;
      v = v.replace(/\s+/g, ' ').trim();
      if (!v || seen[v] || size >= limit) return;
      seen[v] = 1;
      v = v.slice(0, limit - size);
      out.push(v);
      size += v.length + 1;
    }
    function take(o) {
      Object.keys(TEXT_KEYS).forEach(function (k) { add(o[k]); });
      // what was typed into a text morph is kept on its chunks (the run-by-run pieces of styled text): joined, so a phrase that
      // crosses from one style to the next is still one phrase
      if (Array.isArray(o.textChunks)) {
        add(o.textChunks.map(function (r) {
          var c = r && r.__isSmartRef__ && reg[String(r.id)];
          return c && typeof c.storedString === 'string' ? c.storedString : '';
        }).join(''));
      }
    }
    // Only morphs that are IN the world are read: from the world down through `submorphs`. The registry also holds what the world
    // merely remembers (the menu item last clicked, the undo queue, the hand), and a menu's "Save world" would otherwise be found
    // in every world. A string kept on a morph and again on its chunks is listed once.
    var root = data.id != null ? reg[String(data.id)] : null;
    if (root && typeof root === 'object' && Array.isArray(root.submorphs)) {
      var visited = Object.create(null), stack = [String(data.id)];
      while (stack.length) {
        var id = stack.pop(), o = reg[id];
        if (visited[id] || !o || typeof o !== 'object') continue;
        visited[id] = 1;
        take(o);
        (Array.isArray(o.submorphs) ? o.submorphs : []).slice().reverse().forEach(function (r) {
          if (r && r.__isSmartRef__ && r.id != null) stack.push(String(r.id));
        });
      }
    } else {
      // data of a shape this does not know: better some noise than a world that can never be found by its text
      Object.keys(reg).forEach(function (id) { if (reg[id] && typeof reg[id] === 'object') take(reg[id]); });
    }
    return out.join('\n');
  }

  // lower case, accents removed, so "Café" and "cafe" meet
  function fold(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

  // "two words" and "a \"quoted phrase\"" -> ['two','words'] and ['a','quoted phrase']
  function terms(query) {
    var out = [], re = /"([^"]+)"|(\S+)/g, m;
    while ((m = re.exec(String(query == null ? '' : query)))) {
      var t = fold(m[1] != null ? m[1] : m[2]).replace(/\s+/g, ' ').trim().replace(/^"+|"+$/g, '');
      if (t) out.push(t);
    }
    return out;
  }

  function countIn(hay, needle, cap) {
    var n = 0, i = hay.indexOf(needle);
    while (i >= 0 && n < cap) { n++; i = hay.indexOf(needle, i + needle.length); }
    return n;
  }
  function wordStart(hay, needle) { return hay.indexOf(needle) === 0 || hay.indexOf(' ' + needle) >= 0; }

  // A piece of the body around the first hit, cut from the ORIGINAL text (folding keeps the length of what it folds for the
  // scripts we care about; when it does not, the slice is just a little off, never wrong in kind).
  function snippet(text, term) {
    var f = fold(text), i = f.indexOf(term);
    if (i < 0) return '';
    var from = Math.max(0, i - 30), to = Math.min(text.length, i + term.length + 50);
    return (from > 0 ? '… ' : '') + text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < text.length ? ' …' : '');
  }

  function search(entries, query) {
    var ts = terms(query);
    if (!ts.length) return [];
    var hits = [];
    (entries || []).forEach(function (e) {
      var name = fold(e.name), tags = fold((e.tags || []).join(' ')), note = fold(e.note), text = fold(e.text);
      var score = 0, where = {}, snip = '';
      for (var i = 0; i < ts.length; i++) {
        var t = ts[i], s = 0;
        if (name === t) { s += 120; where.name = 1; }
        else if (name.indexOf(t) >= 0) { s += wordStart(name, t) ? 80 : 50; where.name = 1; }
        if (tags.indexOf(t) >= 0) { s += 40; where.tags = 1; }
        if (note.indexOf(t) >= 0) { s += 20; where.note = 1; }
        var c = countIn(text, t, 5);
        if (c) { s += 5 + c; where.text = 1; if (!snip) snip = snippet(e.text || '', t); }
        if (!s) return;                        // every term has to be found somewhere
        score += s;
      }
      hits.push({ name: e.name, score: score, where: Object.keys(where), snippet: where.text ? snip : '' });
    });
    return hits.sort(function (a, b) { return b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
  }

  return { extract: extract, search: search, terms: terms, fold: fold, fileIds: fileIds, MAX_CHARS: MAX_CHARS };
});
