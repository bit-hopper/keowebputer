// S-expression reader. Parser.next() returns one datum per call (or EOF), so
// the REPL can run form N before form N+1 is even read -- macros defined by
// earlier forms are visible to later ones, and a syntax error late in a cell
// doesn't stop the earlier forms from running.
import {
  Pair, NIL, EOF, UNSPEC, DEFAULT, SString, makeChar, intern, arrayToList,
} from './types.js';
import { parseNumber } from './numeric.js';
import { parseError } from './errors.js';

const DELIMS = new Set([' ', '\t', '\n', '\r', '\f', '(', ')', '[', ']', '"', ';']);
const CHAR_NAMES = {
  space: 32, newline: 10, tab: 9, nul: 0, null: 0, return: 13, linefeed: 10,
  altmode: 27, escape: 27, backspace: 8, delete: 127, rubout: 127, alarm: 7, page: 12,
};

const QUOTE = intern('quote'), QUASI = intern('quasiquote');
const UNQUOTE = intern('unquote'), UNQUOTE_SPLICING = intern('unquote-splicing');

export class Parser {
  constructor(text) {
    this.s = text;
    this.i = 0;
    this.lang = null;
    this._readLangLine();
  }

  // `#lang name` as the first line selects a library (see interpreter.js).
  _readLangLine() {
    const m = /^\s*#lang[ \t]+([^\s]+)[^\n]*(\n|$)/.exec(this.s);
    if (m) { this.lang = m[1]; this.i = m[0].length; }
  }

  // The `#lang` of a source string without constructing a Parser for it.
  static extractLang(text) {
    const m = /^\s*#lang[ \t]+([^\s]+)/.exec(text);
    return m ? m[1] : null;
  }

  next() {
    this._skipWs();
    if (this.i >= this.s.length) return EOF;
    return this._datum();
  }

  readAll() {
    const out = [];
    for (let d = this.next(); d !== EOF; d = this.next()) out.push(d);
    return out;
  }

  _skipWs() {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { this.i++; continue; }
      if (c === ';') { while (this.i < s.length && s[this.i] !== '\n') this.i++; continue; }
      if (c === '#' && s[this.i + 1] === '|') { this._blockComment(); continue; }
      if (c === '#' && s[this.i + 1] === ';') { this.i += 2; this._skipWs(); if (this.i >= s.length) throw parseError('Unexpected end of input after #;'); this._datum(); continue; }
      return;
    }
  }

  _blockComment() {
    const s = this.s;
    let depth = 0;
    while (this.i < s.length) {
      if (s[this.i] === '#' && s[this.i + 1] === '|') { depth++; this.i += 2; }
      else if (s[this.i] === '|' && s[this.i + 1] === '#') { depth--; this.i += 2; if (depth === 0) return; }
      else this.i++;
    }
    throw parseError('Unterminated block comment');
  }

  _datum() {
    this._skipWs();
    const s = this.s;
    if (this.i >= s.length) throw parseError('Unexpected end of input');
    const c = s[this.i];
    switch (c) {
      case '(': this.i++; return this._list(')');
      case '[': this.i++; return this._list(']');
      case ')': case ']': this.i++; throw parseError('Unbalanced close parenthesis');
      case "'": this.i++; return this._wrap(QUOTE);
      case '`': this.i++; return this._wrap(QUASI);
      case ',':
        this.i++;
        if (s[this.i] === '@') { this.i++; return this._wrap(UNQUOTE_SPLICING); }
        return this._wrap(UNQUOTE);
      case '"': this.i++; return this._string();
      case '#': return this._hash();
      case '|': return this._token();
      default: return this._token();
    }
  }

  _wrap(sym) {
    this._skipWs();
    if (this.i >= this.s.length) throw parseError('Unexpected end of input after quote');
    const d = this._datum();
    return new Pair(sym, new Pair(d, NIL));
  }

  _list(close) {
    const items = [];
    let tail = NIL;
    for (;;) {
      this._skipWs();
      if (this.i >= this.s.length) throw parseError('Unexpected end of input (missing close parenthesis)');
      const c = this.s[this.i];
      if (c === ')' || c === ']') { this.i++; break; }
      if (c === '.' && DELIMS.has(this.s[this.i + 1] ?? ' ') && items.length > 0) {
        this.i++;
        tail = this._datum();
        this._skipWs();
        const e = this.s[this.i];
        if (e !== ')' && e !== ']') throw parseError('Bad dotted list');
        this.i++;
        break;
      }
      items.push(this._datum());
    }
    return arrayToList(items, tail);
  }

  _string() {
    const s = this.s;
    let out = '';
    for (;;) {
      if (this.i >= s.length) throw parseError('Unterminated string');
      const c = s[this.i++];
      if (c === '"') break;
      if (c === '\\') {
        const e = s[this.i++];
        switch (e) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case 'a': out += '\x07'; break;
          case '0': out += '\0'; break;
          case '\\': out += '\\'; break;
          case '"': out += '"'; break;
          case 'x': {
            const semi = s.indexOf(';', this.i);
            if (semi < 0) throw parseError('Bad \\x escape in string');
            out += String.fromCodePoint(parseInt(s.slice(this.i, semi), 16));
            this.i = semi + 1;
            break;
          }
          case '\n': { // line continuation: skip leading whitespace on next line
            while (s[this.i] === ' ' || s[this.i] === '\t') this.i++;
            break;
          }
          default:
            if (e === ' ' || e === '\t') { // \<spaces><newline><spaces>
              let j = this.i;
              while (s[j] === ' ' || s[j] === '\t') j++;
              if (s[j] === '\n') { j++; while (s[j] === ' ' || s[j] === '\t') j++; this.i = j; break; }
            }
            out += e;
        }
      } else out += c;
    }
    return new SString(out);
  }

  _hash() {
    const s = this.s;
    const n = s[this.i + 1];
    if (n === '(') { this.i += 2; return this._vector(); }
    if (n === '\\') return this._char();
    if (n === '!') {
      const tok = this._rawToken();
      if (tok === '#!default') return DEFAULT;
      if (tok === '#!eof') return EOF;
      if (tok === '#!unspecific') return UNSPEC;
      if (tok === '#!optional' || tok === '#!rest') return intern(tok);
      throw parseError('Unknown # syntax: ' + tok);
    }
    const tok = this._rawToken();
    const lower = tok.toLowerCase();   // the capital forms #T and #F are accepted too
    if (lower === '#t' || lower === '#true') return true;
    if (lower === '#f' || lower === '#false') return false;
    const num = parseNumber(tok);
    if (num !== null) return num;
    throw parseError('Unknown # syntax: ' + tok);
  }

  _vector() {
    const items = [];
    for (;;) {
      this._skipWs();
      if (this.i >= this.s.length) throw parseError('Unexpected end of input in vector');
      const c = this.s[this.i];
      if (c === ')' || c === ']') { this.i++; break; }
      items.push(this._datum());
    }
    return items;
  }

  _char() {
    const s = this.s;
    this.i += 2; // past #\
    if (this.i >= s.length) throw parseError('Unexpected end of input after #\\');
    const start = this.i;
    this.i += String.fromCodePoint(s.codePointAt(this.i)).length; // always consume one char
    while (this.i < s.length && !DELIMS.has(s[this.i])) this.i++;
    const tok = s.slice(start, this.i);
    if ([...tok].length === 1) return makeChar(tok.codePointAt(0));
    const lower = tok.toLowerCase();
    if (lower in CHAR_NAMES) return makeChar(CHAR_NAMES[lower]);
    if ((lower[0] === 'x' || lower[0] === 'u') && /^[0-9a-f]+$/.test(lower.slice(1))) return makeChar(parseInt(lower.slice(1), 16));
    // Something like #\a followed by non-delimiter junk: take just the first char.
    this.i = start + String.fromCodePoint(tok.codePointAt(0)).length;
    return makeChar(tok.codePointAt(0));
  }

  _rawToken() {
    const s = this.s;
    const start = this.i;
    while (this.i < s.length && !DELIMS.has(s[this.i])) this.i++;
    return s.slice(start, this.i);
  }

  _token() {
    const s = this.s;
    // |symbol with spaces|
    if (s[this.i] === '|') {
      this.i++;
      const end = s.indexOf('|', this.i);
      if (end < 0) throw parseError('Unterminated |symbol|');
      const name = s.slice(this.i, end);
      this.i = end + 1;
      return intern(name);
    }
    const tok = this._rawToken();
    if (tok === '') { this.i++; throw parseError('Unexpected character: ' + s[this.i - 1]); }
    const num = parseNumber(tok);
    if (num !== null) return num;
    return intern(tok);
  }
}

// Read every datum in a string (used by tests and the `read` primitive on string ports).
export function readAll(text) { return new Parser(text).readAll(); }
