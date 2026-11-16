/**
 * lively.identity.SchemeEditing
 *
 * Paren-aware editing for the wiki's Scheme code cells. A cell is a text block
 * of the wiki editor (ProseMirror), so this edits the document's own text:
 *   - bracket matching: the bracket next to the caret and its partner are
 *     highlighted (an unmatched one is flagged) by inline decorations;
 *   - auto-close for ( [ and ", overtyping of a closer that is already there,
 *     Backspace removing an empty pair, wrapping a selection;
 *   - Enter keeps the new line indented the Lisp way; Tab re-indents the
 *     current line or every selected line (Shift+Tab is left alone so keyboard
 *     focus can still leave the cell; so can Escape).
 *
 * The pure text functions (scan / matchAt / indentFor / reindent / ...) touch
 * no DOM and are unit-tested under Node (tests/scheme/editing.test.js);
 * handleKeyDown() and decorations() are the ProseMirror part, called by
 * WikiEditor's code-cell plugin (the language registry's `editing` field names
 * this module). Each edit is ONE transaction, so it is one step in the
 * document and one undo.
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

    // ---- ProseMirror glue -------------------------------------------------
    // WikiEditor calls handleKeyDown and decorations for a code cell whose language names this helper in the registry
    // (`editing`). A cell is a text block, so a position inside it IS a text offset: offset = position - base, where base is the
    // position of the cell's first character, and a line break is a "\n" in the text. PM is the editor's ProseMirror bundle
    // (state, view); nothing here touches the DOM.

    function lineIndexOf(text, pos) {
      var n = 0;
      for (var i = 0; i < pos && i < text.length; i++) if (text.charAt(i) === '\n') n++;
      return n;
    }

    /**
     * The cell the selection is in, when the WHOLE selection is inside one cell: { text, base, s, t } (s and t are the
     * selection's start and end as offsets into the text), else null.
     */
    function cellAt(state) {
      var sel = state.selection;
      var $from = sel.$from;
      if ($from.parent.type.name !== 'code_cell' || !$from.sameParent(sel.$to)) return null;
      var base = $from.start();
      return { text: $from.parent.textContent, base: base, s: sel.from - base, t: sel.to - base };
    }

    /**
     * Replaces [start, end) of the cell's text with `str` in ONE transaction (one step for the document, so one undo) and
     * leaves the selection at [selStart, selEnd] (offsets in the NEW text).
     */
    function replaceRange(view, PM, cell, start, end, str, selStart, selEnd) {
      var tr = view.state.tr;
      if (str === '') tr.delete(cell.base + start, cell.base + end);
      else tr.insertText(str, cell.base + start, cell.base + end);
      tr.setSelection(PM.state.TextSelection.create(tr.doc, cell.base + selStart, cell.base + (selEnd === undefined ? selStart : selEnd)));
      view.dispatch(tr.scrollIntoView());
    }

    function moveCaret(view, PM, cell, offset) {
      view.dispatch(view.state.tr.setSelection(PM.state.TextSelection.create(view.state.doc, cell.base + offset)));
    }

    function isPlainKey(e) { return !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing; }

    /**
     * A key pressed in a Scheme cell: true when it was handled here (the caller must not run its own handlers), false to let the
     * editor treat it as any other key. Auto-close for ( [ and ", overtyping a closer that is already there, Backspace removing
     * an empty pair, wrapping a selection, Enter keeping the new line indented the Lisp way, Tab re-indenting the current line
     * or every selected line. Shift+Tab and Escape are left alone so keyboard focus can still leave the cell.
     */
    function handleKeyDown(view, e, PM) {
      if (!isPlainKey(e)) return false;
      var cell = cellAt(view.state);
      if (!cell) return false;
      var text = cell.text;
      var s = cell.s;
      var t = cell.t;
      var key = e.key;
      var next = text.charAt(t);
      var prev = text.charAt(s - 1);

      if (key === 'Tab' && !e.shiftKey) {
        var firstLine = lineIndexOf(text, s);
        var lastLine = lineIndexOf(text, t > s && text.charAt(t - 1) === '\n' ? t - 1 : t);
        var res = reindent(text, firstLine, lastLine);
        if (res.text === text) {
          // already indented: just move the caret past the leading whitespace
          if (s === t) {
            var ls = lineStartOf(text, s);
            var lead = /^[ \t]*/.exec(text.substring(ls))[0].length;
            if (s < ls + lead) moveCaret(view, PM, cell, ls + lead);
          }
          return true;
        }
        // Replace the whole affected line range in one edit (one undo step).
        var lines = text.split('\n');
        var rangeStart = 0;
        for (var a = 0; a < firstLine; a++) rangeStart += lines[a].length + 1;
        var oldBlock = lines.slice(firstLine, lastLine + 1).join('\n');
        var newBlock = res.text.split('\n').slice(firstLine, lastLine + 1).join('\n');
        // map the caret / selection through the per-line deltas
        var mapOffset = function (off) {
          var line = lineIndexOf(text, off);
          var lineBegin = lineStartOf(text, off);
          var shift = 0;
          for (var l = firstLine; l < line && l <= lastLine; l++) shift += res.deltas[l] || 0;
          if (line < firstLine || line > lastLine) return off + shift;
          var lead2 = /^[ \t]*/.exec(text.substring(lineBegin))[0].length;
          var col = off - lineBegin;
          var d = res.deltas[line] || 0;
          return lineBegin + shift + (col <= lead2 ? lead2 + d : col + d);
        };
        replaceRange(view, PM, cell, rangeStart, rangeStart + oldBlock.length, newBlock, mapOffset(s), mapOffset(t));
        return true;
      }

      if (key === 'Enter' && !e.shiftKey) {
        var tail = t;
        while (text.charAt(tail) === ' ' || text.charAt(tail) === '\t') tail++;
        var head = text.substring(0, s) + '\n';
        var rest = text.substring(tail);
        var want = indentFor(head + rest, head.length);
        var pad = want === null ? '' : spaces(want);
        replaceRange(view, PM, cell, s, tail, '\n' + pad, s + 1 + pad.length);
        return true;
      }

      if (key === 'Backspace' && s === t && s > 0) {
        var pairOK = (prev === '(' && next === ')') || (prev === '[' && next === ']') || (prev === '"' && next === '"');
        if (!pairOK) return false;
        replaceRange(view, PM, cell, s - 1, s + 1, '', s - 1);
        return true;
      }

      var ctx = scan(text, s).context;

      if (CLOSERS.indexOf(key) !== -1 && key.length === 1) {
        if (s === t && next === key && ctx === 'code') { moveCaret(view, PM, cell, s + 1); return true; }
        return false;
      }

      if (key === '"') {
        if (ctx === 'comment' || ctx === 'blockcomment') return false;
        if (s === t && ctx === 'string') {
          if (next === '"') { moveCaret(view, PM, cell, s + 1); return true; }
          return false;
        }
        if (prev === '\\' || /[\w]/.test(prev || '')) return false; // #\" or a word char
        if (s !== t) replaceRange(view, PM, cell, s, t, '"' + text.substring(s, t) + '"', t + 2);
        else if (isDelimiter(next) || CLOSERS.indexOf(next) !== -1) replaceRange(view, PM, cell, s, s, '""', s + 1);
        else replaceRange(view, PM, cell, s, s, '"', s + 1);
        return true;
      }

      if (OPENERS.indexOf(key) !== -1 && key.length === 1) {
        if (ctx !== 'code') return false;
        if (prev === '\\' && text.charAt(s - 2) === '#') return false; // the char literal #\(
        var close = key === '(' ? ')' : ']';
        if (s !== t) { replaceRange(view, PM, cell, s, t, key + text.substring(s, t) + close, s + 1, t + 1); return true; }
        if (isDelimiter(next) || CLOSERS.indexOf(next) !== -1) replaceRange(view, PM, cell, s, s, key + close, s + 1);
        else replaceRange(view, PM, cell, s, s, key, s + 1);
        return true;
      }

      return false;
    }

    /**
     * Bracket matching: the bracket next to the caret and its partner get the class lively-bracket-ok, or a bracket with no
     * partner lively-bracket-bad. A DecorationSet, or null when the caret is not collapsed inside a cell or touches no bracket.
     */
    function decorations(state, PM) {
      var cell = cellAt(state);
      if (!cell || cell.s !== cell.t) return null;
      var m = matchAt(cell.text, cell.s);
      if (!m) return null;
      var marks = m.b === -1 ? [[m.a, 'bad']] : [[m.a, 'ok'], [m.b, 'ok']];
      return PM.view.DecorationSet.create(state.doc, marks.map(function (mk) {
        return PM.view.Decoration.inline(cell.base + mk[0], cell.base + mk[0] + 1, { class: 'lively-bracket-' + mk[1] });
      }));
    }

    lively.identity.SchemeEditing = {
      scan: scan,
      matchAt: matchAt,
      indentFor: indentFor,
      reindent: reindent,
      handleKeyDown: handleKeyDown,
      decorations: decorations,
    };
  });
