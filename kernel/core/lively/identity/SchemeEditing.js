/**
 * lively.identity.SchemeEditing
 *
 * Paren-aware editing for the wiki's Scheme code cells, layered over a plain
 * <textarea>:
 *   - bracket matching: the bracket next to the caret and its partner are
 *     highlighted (an unmatched one is flagged), drawn on a backdrop behind the
 *     transparent-background textarea so the textarea itself stays a normal,
 *     accessible, undoable text control;
 *   - auto-close for ( [ and ", overtyping of a closer that is already there,
 *     Backspace removing an empty pair, wrapping a selection;
 *   - Enter keeps the new line indented the Lisp way; Tab re-indents the
 *     current line or every selected line (Shift+Tab is left alone so keyboard
 *     focus can still leave the box; so can Escape).
 *
 * The pure text functions (scan / matchAt / indentFor / reindent / ...) touch
 * no DOM and are unit-tested under Node (tests/scheme/editing.test.js); attach()
 * is the only DOM part.
 */

module('lively.identity.SchemeEditing')
  .requires()
  .toRun(function () {

    var OPENERS = '([';
    var CLOSERS = ')]';

    // Operators whose body lines indent by 2 under the opening bracket instead
    // of aligning with the first argument.
    var BODY_FORMS = {
      'lambda': 1, 'let': 1, 'let*': 1, 'letrec': 1, 'letrec*': 1, 'let-values': 1, 'let*-values': 1,
      'let-syntax': 1, 'letrec-syntax': 1, 'syntax-rules': 1, 'when': 1, 'unless': 1, 'do': 1, 'case': 1,
      'cases': 1, 'parameterize': 1, 'fluid-let': 1, 'guard': 1, 'named-lambda': 1, 'case-lambda': 1,
      'dynamic-wind': 1, 'receive': 1, 'letcc': 1, 'delay': 1, 'make-promise': 1, 'cons-stream': 1,
    };

    function isBodyOperator(name) {
      if (!name) return false;
      if (BODY_FORMS.hasOwnProperty(name)) return true;
      // define, define-record-type, define-syntax, with-..., call-with-...
      return /^(def|with-|call-with-)/.test(name);
    }

    function isSymbolText(t) {
      return !!t && !/^[+-]?\.?\d/.test(t) && !/^["'#`,]/.test(t);
    }

    function isDelimiter(ch) {
      return ch === undefined || ch === '' || /[\s()\[\]";]/.test(ch);
    }

    /**
     * Walks `text` up to `limit` (default: all of it), tracking strings,
     * comments and nesting. Returns
     *   { context: 'code'|'string'|'comment'|'blockcomment' at `limit`,
     *     stack:   the still-open brackets at `limit`, innermost last, each
     *              { pos, col, ch, elems: [{pos, col, text}] } (elems = the
     *              completed-or-started elements seen so far in that list),
     *     pairs:   every bracket outside strings/comments in the scanned range:
     *              { pos, ch, match } where match is the partner's pos or -1 }
     */
    function scan(text, limit) {
      if (limit === undefined || limit > text.length) limit = text.length;
      var stack = [];
      var pairs = [];
      var byPos = {};
      var i = 0;
      var lineStart = 0;
      var context = 'code';
      var blockDepth = 0;

      var prefixPos = -1; // start of a pending quote / unquote / vector prefix

      function noteElement(pos) {
        if (prefixPos >= 0) { pos = prefixPos; prefixPos = -1; }
        var top = stack[stack.length - 1];
        if (!top) return null;
        var el = { pos: pos, col: pos - lineStart, text: '' };
        top.elems.push(el);
        return el;
      }

      while (i < limit) {
        var ch = text.charAt(i);
        if (ch === '\n') { lineStart = i + 1; i++; continue; }

        if (blockDepth > 0) {
          if (ch === '|' && text.charAt(i + 1) === '#') { blockDepth--; i += 2; continue; }
          if (ch === '#' && text.charAt(i + 1) === '|') { blockDepth++; i += 2; continue; }
          i++; continue;
        }

        if (ch === ';') {
          // line comment: runs to end of line
          while (i < limit && text.charAt(i) !== '\n') i++;
          if (i >= limit) { context = 'comment'; break; }
          continue;
        }

        if (ch === '#' && text.charAt(i + 1) === '|') { blockDepth = 1; i += 2; continue; }

        if (ch === '"') {
          var strStart = i;
          noteElement(strStart);
          i++;
          var closed = false;
          while (i < limit) {
            var c = text.charAt(i);
            if (c === '\\') { if (text.charAt(i + 1) === '\n') lineStart = i + 2; i += 2; continue; }
            if (c === '\n') lineStart = i + 1;
            if (c === '"') { closed = true; i++; break; }
            i++;
          }
          if (!closed) { context = 'string'; break; }
          continue;
        }

        if (ch === '#' && text.charAt(i + 1) === '\\') {
          // character literal: #\( #\space #\a ...
          noteElement(i);
          i += 3;
          while (i < limit && !isDelimiter(text.charAt(i))) i++;
          continue;
        }

        if (OPENERS.indexOf(ch) !== -1) {
          noteElement(i);
          var entry = { pos: i, col: i - lineStart, ch: ch, elems: [] };
          stack.push(entry);
          var pair = { pos: i, ch: ch, match: -1 };
          pairs.push(pair);
          byPos[i] = pair;
          entry.pair = pair;
          i++;
          continue;
        }

        if (CLOSERS.indexOf(ch) !== -1) {
          var cp = { pos: i, ch: ch, match: -1 };
          pairs.push(cp);
          byPos[i] = cp;
          if (stack.length) {
            var open = stack.pop();
            open.pair.match = i;
            cp.match = open.pos;
          }
          i++;
          continue;
        }

        if (/\s/.test(ch)) { i++; continue; }

        // A quote / quasiquote / unquote / vector prefix belongs to the datum after it.
        if (ch === "'" || ch === '`' || ch === ',' || (ch === '#' && OPENERS.indexOf(text.charAt(i + 1)) !== -1)) {
          if (prefixPos < 0) prefixPos = i;
          i++;
          if (ch === ',' && text.charAt(i) === '@') i++;
          continue;
        }

        // an atom (symbol, number, ...)
        var start = i;
        var el = noteElement(start);
        while (i < limit && !isDelimiter(text.charAt(i))) i++;
        if (el) el.text = text.substring(start, i);
      }

      if (blockDepth > 0) context = 'blockcomment';
      return { context: context, stack: stack, pairs: pairs, byPos: byPos };
    }

    /** The bracket at/next to `caret` and its partner: { a, b } (b is -1 when unmatched), or null. */
    function matchAt(text, caret) {
      var sc = scan(text);
      var candidates = [caret - 1, caret];
      for (var k = 0; k < candidates.length; k++) {
        var p = sc.byPos[candidates[k]];
        if (p) return { a: p.pos, b: p.match };
      }
      return null;
    }

    function lineStartOf(text, pos) {
      return text.lastIndexOf('\n', pos - 1) + 1;
    }

    /**
     * The number of spaces line `lineStart` (a line-start offset in `text`)
     * should be indented by, judged from the text before it. null = leave the
     * line alone (it begins inside a string or a block comment).
     */
    function indentFor(text, lineStart) {
      var sc = scan(text, lineStart);
      if (sc.context === 'string' || sc.context === 'blockcomment') return null;
      var open = sc.stack[sc.stack.length - 1];
      if (!open) return 0;

      var elems = open.elems;
      var prev = text.charAt(open.pos - 1);
      var dataList = prev === "'" || prev === '`' || prev === ',' || prev === '@' || prev === '#';
      var op = elems[0];

      if (dataList || !op || !isSymbolText(op.text)) {
        // a data list, a binding list, ((f) x) ...: align with the first element
        return op ? op.col : open.col + 1;
      }
      if (isBodyOperator(op.text)) return open.col + 2;
      // a clause of (cases type expr (variant (field ...) body ...) ...): its body lines sit 2 in
      var parent = sc.stack[sc.stack.length - 2];
      if (parent && parent.elems[0] && parent.elems[0].text === 'cases') return open.col + 2;
      if (elems.length >= 2) return elems[1].col;
      return open.col + 2;
    }

    function spaces(n) { return new Array(n + 1).join(' '); }

    /**
     * Re-indents lines `firstLine`..`lastLine` (0-based). Top-down on the
     * evolving text, since moving a line moves the columns later lines align
     * to. Returns { text, deltas } where deltas[n] is how much line n's leading
     * whitespace changed.
     */
    function reindent(text, firstLine, lastLine) {
      var lines = text.split('\n');
      var deltas = []; // per line: change in leading-whitespace length
      var indentBlank = firstLine === lastLine; // a lone blank line gets indented; blank lines in a block are emptied
      for (var n = firstLine; n <= lastLine && n < lines.length; n++) {
        var start = 0;
        for (var k = 0; k < n; k++) start += lines[k].length + 1;
        var cur = lines[n];
        var lead = /^[ \t]*/.exec(cur)[0].length;
        deltas[n] = 0;
        if (cur.trim() === '' && !indentBlank) {
          deltas[n] = -cur.length;
          lines[n] = '';
          continue;
        }
        var want = indentFor(lines.join('\n'), start);
        if (want === null) continue;
        lines[n] = spaces(want) + cur.substring(lead);
        deltas[n] = want - lead;
      }
      return { text: lines.join('\n'), deltas: deltas };
    }

    // ---- DOM glue ---------------------------------------------------------

    function lineIndexOf(text, pos) {
      var n = 0;
      for (var i = 0; i < pos && i < text.length; i++) if (text.charAt(i) === '\n') n++;
      return n;
    }

    function escapeHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /**
     * Replaces [start, end) of the textarea with `str` through the browser's
     * own edit path (so Ctrl+Z still undoes it and an `input` event fires),
     * falling back to setRangeText. Leaves the caret at [selStart, selEnd]
     * (offsets in the NEW text).
     */
    function replaceRange(ta, start, end, str, selStart, selEnd) {
      ta.focus();
      ta.setSelectionRange(start, end);
      var expected = ta.value.substring(0, start) + str + ta.value.substring(end);
      var done = false;
      try {
        done = str === '' ? document.execCommand('delete') : document.execCommand('insertText', false, str);
      } catch (e) { done = false; }
      if (!done || ta.value !== expected) {
        ta.value = expected;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      ta.setSelectionRange(selStart, selEnd === undefined ? selStart : selEnd);
    }

    function attach(ta) {
      var wrap = document.createElement('div');
      wrap.className = 'lively-code-cell-editwrap';
      var back = document.createElement('div');
      back.className = 'lively-code-cell-backdrop';
      var inner = document.createElement('div');
      inner.className = 'lively-code-cell-backdrop-inner';
      back.appendChild(inner);
      ta.parentNode.insertBefore(wrap, ta);
      wrap.appendChild(back);
      wrap.appendChild(ta);
      ta.setAttribute('wrap', 'off');
      ta.setAttribute('autocapitalize', 'off');
      ta.setAttribute('autocorrect', 'off');

      function syncScroll() {
        inner.style.transform = 'translate(' + (-ta.scrollLeft) + 'px,' + (-ta.scrollTop) + 'px)';
      }

      function refresh() {
        var text = ta.value;
        var html = escapeHtml(text);
        if (document.activeElement === ta && ta.selectionStart === ta.selectionEnd) {
          var m = matchAt(text, ta.selectionStart);
          if (m) {
            var marks = m.b === -1 ? [[m.a, 'bad']] : [[m.a, 'ok'], [m.b, 'ok']];
            marks.sort(function (x, y) { return x[0] - y[0]; });
            var out = '';
            var cursor = 0;
            marks.forEach(function (mk) {
              out += escapeHtml(text.substring(cursor, mk[0])) +
                '<mark class="' + mk[1] + '">' + escapeHtml(text.charAt(mk[0])) + '</mark>';
              cursor = mk[0] + 1;
            });
            html = out + escapeHtml(text.substring(cursor));
          }
        }
        // a trailing newline needs a visible last line to keep heights equal
        inner.innerHTML = html + '\n';
        syncScroll();
      }

      function isPlainKey(e) { return !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing; }

      function onKeyDown(e) {
        if (!isPlainKey(e)) return;
        var text = ta.value;
        var s = ta.selectionStart;
        var t = ta.selectionEnd;
        var key = e.key;
        var next = text.charAt(t);
        var prev = text.charAt(s - 1);

        if (key === 'Tab' && !e.shiftKey) {
          e.preventDefault();
          var firstLine = lineIndexOf(text, s);
          var lastLine = lineIndexOf(text, t > s && text.charAt(t - 1) === '\n' ? t - 1 : t);
          var res = reindent(text, firstLine, lastLine);
          if (res.text === text) {
            // already indented: just move the caret past the leading whitespace
            if (s === t) {
              var ls = lineStartOf(text, s);
              var lead = /^[ \t]*/.exec(text.substring(ls))[0].length;
              if (s < ls + lead) ta.setSelectionRange(ls + lead, ls + lead);
            }
            return;
          }
          // Replace the whole affected line range in one edit (one undo step).
          var lines = text.split('\n');
          var rangeStart = 0;
          for (var a = 0; a < firstLine; a++) rangeStart += lines[a].length + 1;
          var oldBlock = lines.slice(firstLine, lastLine + 1).join('\n');
          var newBlock = res.text.split('\n').slice(firstLine, lastLine + 1).join('\n');
          // map the caret / selection through the per-line deltas
          function mapOffset(off) {
            var line = lineIndexOf(text, off);
            var lineBegin = lineStartOf(text, off);
            var shift = 0;
            for (var l = firstLine; l < line && l <= lastLine; l++) shift += res.deltas[l] || 0;
            if (line < firstLine || line > lastLine) return off + shift;
            var lead2 = /^[ \t]*/.exec(text.substring(lineBegin))[0].length;
            var col = off - lineBegin;
            var d = res.deltas[line] || 0;
            return lineBegin + shift + (col <= lead2 ? lead2 + d : col + d);
          }
          var ns = mapOffset(s);
          var ne = mapOffset(t);
          replaceRange(ta, rangeStart, rangeStart + oldBlock.length, newBlock, ns, ne);
          return;
        }

        if (key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          var tail = t;
          while (text.charAt(tail) === ' ' || text.charAt(tail) === '\t') tail++;
          var head = text.substring(0, s) + '\n';
          var rest = text.substring(tail);
          var want = indentFor(head + rest, head.length);
          var pad = want === null ? '' : spaces(want);
          replaceRange(ta, s, tail, '\n' + pad, s + 1 + pad.length);
          return;
        }

        if (key === 'Backspace' && s === t && s > 0) {
          var pairOK = (prev === '(' && next === ')') || (prev === '[' && next === ']') || (prev === '"' && next === '"');
          if (pairOK) {
            e.preventDefault();
            replaceRange(ta, s - 1, s + 1, '', s - 1);
          }
          return;
        }

        var ctx = scan(text, s).context;

        if (CLOSERS.indexOf(key) !== -1 && key.length === 1) {
          if (s === t && next === key && ctx === 'code') {
            e.preventDefault();
            ta.setSelectionRange(s + 1, s + 1);
          }
          return;
        }

        if (key === '"') {
          if (ctx === 'comment' || ctx === 'blockcomment') return;
          if (s === t && ctx === 'string') {
            if (next === '"') { e.preventDefault(); ta.setSelectionRange(s + 1, s + 1); }
            return;
          }
          if (prev === '\\' || /[\w]/.test(prev || '')) return; // #\" or a word char
          e.preventDefault();
          if (s !== t) replaceRange(ta, s, t, '"' + text.substring(s, t) + '"', t + 2);
          else if (isDelimiter(next) || CLOSERS.indexOf(next) !== -1) replaceRange(ta, s, s, '""', s + 1);
          else replaceRange(ta, s, s, '"', s + 1);
          return;
        }

        if (OPENERS.indexOf(key) !== -1 && key.length === 1) {
          if (ctx !== 'code') return;
          if (prev === '\\' && text.charAt(s - 2) === '#') return; // the char literal #\(
          var close = key === '(' ? ')' : ']';
          e.preventDefault();
          if (s !== t) { replaceRange(ta, s, t, key + text.substring(s, t) + close, s + 1, t + 1); return; }
          if (isDelimiter(next) || CLOSERS.indexOf(next) !== -1) replaceRange(ta, s, s, key + close, s + 1);
          else replaceRange(ta, s, s, key, s + 1);
          return;
        }
      }

      function onSelectionChange() { if (document.activeElement === ta) refresh(); }

      ta.addEventListener('keydown', onKeyDown);
      ta.addEventListener('input', refresh);
      ta.addEventListener('scroll', syncScroll);
      ta.addEventListener('keyup', refresh);
      ta.addEventListener('mouseup', refresh);
      ta.addEventListener('focus', refresh);
      ta.addEventListener('blur', refresh);
      document.addEventListener('selectionchange', onSelectionChange);
      refresh();

      return {
        refresh: refresh,
        destroy: function () { document.removeEventListener('selectionchange', onSelectionChange); },
      };
    }

    lively.identity.SchemeEditing = {
      scan: scan,
      matchAt: matchAt,
      indentFor: indentFor,
      reindent: reindent,
      attach: attach,
    };
  });
