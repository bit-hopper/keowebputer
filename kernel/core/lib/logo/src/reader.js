// The reader: source text -> Logo DATA (LOGO.md 5.1). It does exactly what READLIST does to an instruction line and
// nothing more. It has no idea what any word means: whether `foo` takes two inputs, whether `5-2` is a subtraction. That
// is decided later, when the line is run (runparse.js, treeify.js), because Logo code is list data: RUN, DEFINE, TEXT and
// FOREACH [ ... ] all treat lists as code and code as lists.
//
// What a "line" is (manual, TOKENIZATION): one physical line, extended onto the next by a trailing tilde, by a trailing
// backslash, or automatically while a bracket, brace, parenthesis or vertical bar is still open. `;` starts a comment that
// runs to the end of the physical line (a tilde ending the comment line still continues the logical line).
//
// Words are delimited here ONLY by whitespace and square brackets / braces. Parentheses and infix operators are NOT word
// delimiters at this stage: `5-2` is the one word "5-2" and `(sum` is the word "(sum". runparse.js splits them later, and
// only when the list is run as code, which is what lets `print first [555-1212 642-8311]` print 555-1212.
//
// The words returned keep their prefix characters: `"abc` stays the word `"abc`, `:x` stays `:x`. Words that contain a
// backslashed or barred character which would otherwise delimit or have meaning come back as QWord (data.js) so that the
// runparser leaves them whole.
//
// Do not use this to read a number or to compare words; that is data.js and numbers.js.

import { QWord, LArray, listFromArray } from './data.js';
import { err, LogoError, CODE } from './errors.js';

// Characters whose quoting by backslash or bars is observable (VBARREDP, manual TOKENIZATION): whitespace, parentheses,
// brackets, braces, infix operators, backslash, bar, tilde, quote, question mark, colon, semicolon.
const SPECIAL_RE = /[\s()\[\]{}+\-*\/=<>\\|~"?:;]/;

// The characters runparse.js splits a word at: a backslash in front of one of these keeps it in the word.
const RUNPARSE_SPLIT_RE = /[()+\-*\/=<>]/;

class LineReadError extends LogoError {}

// Reads logical lines from a source text, one `readLine()` call at a time. A cell's Job owns one of these.
export class LineReader {
  constructor(text) {
    this.text = text.replace(/\r\n?/g, '\n');
    this.pos = 0;
    // "#!" on the first line is a comment (manual): skip that whole line.
    if (this.text.startsWith('#!')) {
      const nl = this.text.indexOf('\n');
      this.pos = nl === -1 ? this.text.length : nl + 1;
    }
  }

  atEnd() { return this.pos >= this.text.length; }

  // Returns {items, raw} for the next logical line, where items is a JS array of data (words, lists, arrays) and raw is
  // the line's source text (continuations included, comments removed is NOT done: raw is exactly what was typed, for
  // FULLTEXT and for echoing). Returns null at end of input. A blank or comment-only line yields {items: [], raw}.
  // Throws a LogoError for an unmatched `]` or `}` or `)`; the position is left after the offending line so the caller
  // can carry on with the next one.
  readLine() {
    if (this.atEnd()) return null;
    const start = this.pos;
    try {
      const items = this._scanLogicalLine();
      return { items, raw: this.text.slice(start, this.pos).replace(/\n$/, '') };
    } catch (e) {
      if (e instanceof LineReadError) {
        // Skip to the end of the physical line that caused the error, so one stray bracket does not swallow the rest.
        const nl = this.text.indexOf('\n', this.pos);
        this.pos = nl === -1 ? this.text.length : nl + 1;
        const wrapped = new LogoError(e.code, e.message, e.culprit);
        wrapped.readError = true;
        throw wrapped;
      }
      throw e;
    }
  }

  // The scanner proper. One pass over the characters from this.pos to the end of the logical line.
  _scanLogicalLine() {
    const text = this.text, n = text.length;
    // Stack of open containers: {kind: 'list' | 'array', items: []}. The bottom one is the line itself.
    const root = { kind: 'line', items: [] };
    const stack = [root];
    let parenDepth = 0;   // unmatched ( in unquoted words: only used to decide whether the line continues
    let word = null;      // the word being built, or null: {buf, special, quoted, bsSpecial, barSpecial}
    let inBar = false;

    const top = () => stack[stack.length - 1];
    const finishWord = () => {
      if (word === null) return;
      // A quoted word at the top level whose protected characters were all backslashed (no bars) remembers that, so PO
      // can print it as typed.
      const viaBackslash = word.special && word.bsSpecial === true && word.barSpecial !== true && word.quoted === true && stack.length === 1;
      top().items.push(word.special ? new QWord(word.buf, viaBackslash) : word.buf);
      word = null;
    };
    // `how` is 'bar' or 'backslash' for a protected character, absent for an ordinary one.
    const addChar = (c, how) => {
      if (word === null) word = { buf: '', special: false, quoted: false };
      word.buf += c;
      if (how !== undefined && SPECIAL_RE.test(c)) {
        word.special = true;
        if (how === 'bar') word.barSpecial = true; else word.bsSpecial = true;
      }
    };

    let i = this.pos;
    for (;;) {
      if (i >= n) {
        // End of text inside an open container or bar: the input ended mid-line. Accept what was read so far; the
        // caller decides whether an unfinished definition is an error.
        finishWord();
        break;
      }
      const c = text[i];

      if (inBar) {
        if (c === '|') { inBar = false; i++; continue; }
        if (c === '\\' && i + 1 < n) { addChar(text[i + 1], 'bar'); i += 2; continue; }
        addChar(c, 'bar');   // a newline inside bars is part of the word; the line continues
        i++;
        continue;
      }

      if (c === '\n') {
        finishWord();
        i++;
        if (stack.length > 1 || parenDepth > 0) {
          // Automatic continuation. A continuation line that is only END is a runaway definition (manual).
          const nl = text.indexOf('\n', i);
          const next = text.slice(i, nl === -1 ? n : nl).trim().toLowerCase();
          if (next === 'end') {
            this.pos = nl === -1 ? n : nl + 1;
            throw new LineReadError(33, 'END inside multi-line instruction');
          }
          continue;
        }
        break;
      }

      if (c === '~' && (i + 1 >= n || text[i + 1] === '\n')) {
        // Explicit continuation: the tilde and the newline vanish. A tilde does not end a word ("abc~\ndef" is abcdef).
        i += 2;
        continue;
      }

      if (c === '\\') {
        if (i + 1 >= n) { i++; continue; }
        // Backslash quotes the next character, newline included (the newline joins the word and the line continues). A
        // backslashed parenthesis, bracket or operator is protected exactly as if it were inside bars: the word becomes a
        // QWord and the runparser leaves it whole, so `"r\(s` is the word r(s and `print 1\+2` calls a procedure named 1+2
        // (checked against the reference, tests/logo/seed/backslash.lg). What loses the protection is a WORD that is
        // re-read from its text -- `runparse "a\(b` splits at the paren, because the backslash is no longer in the text.
        // `viaBackslash` records that no bars were involved, so PO can print the word the way it was typed.
        // Only a character the runparser would split on needs protecting; a backslashed space (or any other character)
        // is simply part of the word, and the rest of the word still ends at an unprotected parenthesis (`"...\ )` in
        // the reference's own unit-test framework). Protection is per word here, so a word that mixes a backslashed
        // paren with an unprotected one (`"a\()`) is not handled.
        addChar(text[i + 1], RUNPARSE_SPLIT_RE.test(text[i + 1]) ? 'backslash' : undefined);
        i += 2;
        continue;
      }

      if (c === '|') { inBar = true; if (word === null) word = { buf: '', special: false }; i++; continue; }

      if (c === ';') {
        // Comment to the end of the physical line. Look for a tilde just before the newline: it still continues the line.
        finishWord();
        const nl = text.indexOf('\n', i);
        const end = nl === -1 ? n : nl;
        const continued = end > i && text[end - 1] === '~';
        i = end;   // the newline (if any) is handled by the main branch next
        if (continued && nl !== -1) i = nl + 1;
        continue;
      }

      if (c === ' ' || c === '\t' || c === '\f' || c === '\v') { finishWord(); i++; continue; }

      if (c === '[') { finishWord(); stack.push({ kind: 'list', items: [] }); i++; continue; }
      if (c === '{') { finishWord(); stack.push({ kind: 'array', items: [] }); i++; continue; }

      if (c === ']' || c === '}') {
        finishWord();
        const want = c === ']' ? 'list' : 'array';
        if (stack.length === 1 || top().kind !== want) {
          this.pos = i + 1;
          throw new LineReadError(c === ']' ? CODE.UNEXPECTED_CLOSE_BRACKET : CODE.UNEXPECTED_CLOSE_BRACE,
            c === ']' ? "unexpected ']'" : "unexpected '}'");
        }
        const done = stack.pop();
        i++;
        let datum;
        if (done.kind === 'list') datum = listFromArray(done.items);
        else {
          // {a b c}@origin : an origin suffix directly after the closing brace.
          let origin = 1;
          const m = /^@(-?\d+)/.exec(text.slice(i, i + 24));
          if (m) { origin = parseInt(m[1], 10); i += m[0].length; }
          datum = new LArray(done.items, origin);
        }
        top().items.push(datum);
        continue;
      }

      // An ordinary character.
      // A quoted word outside brackets is delimited by a parenthesis (manual, TOKENIZATION): `(word "a\ )` ends the word
      // at the `)`. Only an UNQUOTED paren does it, so a backslash- or bar-protected one (handled above) stays in the
      // word, and the character straight after the quote mark is always part of it.
      if ((c === '(' || c === ')') && stack.length === 1 && word !== null && word.quoted && word.buf.length >= 2) finishWord();
      if (word === null) {
        word = { buf: '', special: false };
        word.quoted = c === '"';
      }
      // Parentheses count for continuation only outside square brackets and braces (inside them a paren is just a
      // character of a word). A quoted word is delimited by a parenthesis, so one after its first character counts;
      // the character straight after the quote mark is part of the word, so `"(` does not.
      if (stack.length === 1 && !(word.quoted && word.buf === '"')) {
        if (c === '(') parenDepth++;
        else if (c === ')' && parenDepth > 0) parenDepth--;
      }
      addChar(c);
      i++;
    }

    if (inBar) throw new LineReadError(33, 'END inside multi-line instruction');
    this.pos = i;
    // Close any containers still open at end of text (an unterminated list at end of input): treat as if closed.
    while (stack.length > 1) {
      const done = stack.pop();
      top().items.push(done.kind === 'list' ? listFromArray(done.items) : new LArray(done.items, 1));
    }
    return root.items;
  }
}

// Reads a whole text as a list of data, the way READLIST / PARSE would for one line: used by PARSE and RUNPARSE on a word
// (the word's text is re-read) and by tests. Newlines inside the text are treated as separators.
export function parseText(text) {
  const reader = new LineReader(text.replace(/\n/g, ' '));
  const line = reader.readLine();
  return line ? line.items : [];
}

export { LineReadError };
