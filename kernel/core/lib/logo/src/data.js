// The Logo data model (LOGO.md 5.2). Decided up front because it is invasive to change.
//
//   word    a JS string. A word that looks like a number ("3", "3.50", "-1e3") is a number to arithmetic and NUMBERP
//           but keeps its typed text when printed, so `show "3.50` prints 3.50 (11.5 item 4).
//   number  a JS number. Arithmetic produces these, and an unquoted numeric token in code evaluates to one, which is why
//           `show 1.0` prints 1 but `show "1.0` prints 1.0. Printing goes through numbers.js formatNumber.
//   QWord   a word that was typed with vertical bars or a backslash on a character that would otherwise delimit it
//           ("|a b|", "\(" ...). It exists so the runparser does not split it again and so VBARREDP can answer. It is
//           an object rather than a flag on strings because JS strings cannot carry one. Nearly every primitive should
//           go through isWord / wordText below and never look at `typeof` itself.
//   list    persistent cons cells (Cell) ending in the NIL singleton, so BUTFIRST is O(1): CSLS volume 1 chapters 7-11
//           recurse with BF constantly and an array-backed list would make that quadratic. .SETFIRST / .SETBF mutate cells.
//   array   LArray {items, origin}; `{a b c}` literal, MDARRAY is an array of arrays.
//
// Nothing here knows about evaluation. Do not import machine or primitive code from this file.

import { formatNumber, parseNumber } from './numbers.js';

export class QWord {
  // viaBackslash: the protection came from backslashes alone, in a word typed as "word (PO prints such a word with them).
  constructor(text, viaBackslash = false) { this.text = text; this.viaBackslash = viaBackslash; }
  toString() { return this.text; }
}

export class Cell {
  constructor(first, rest) { this.first = first; this.rest = rest; }
}

// The empty list. A single shared object so `x === NIL` is the emptiness test; it is deliberately not a Cell, so
// `x instanceof Cell` means "non-empty list".
class Nil {}
export const NIL = new Nil();

export class LArray {
  constructor(items, origin = 1) { this.items = items; this.origin = origin; }
}

export const isList = (x) => x === NIL || x instanceof Cell;
export const isArray = (x) => x instanceof LArray;
export const isNumber = (x) => typeof x === 'number';
export const isWord = (x) => typeof x === 'string' || typeof x === 'number' || x instanceof QWord;

// A word's text as it is printed and as character primitives (COUNT, ITEM, FIRST, ...) see it. A JS number prints as
// the reference would (see numbers.js). Call only on a value that isWord.
export function wordText(x) {
  if (typeof x === 'string') return x;
  if (typeof x === 'number') return formatNumber(x);
  return x.text;
}

// The numeric value of a word, or null when it is not a number. A JS number is its own value; a string is parsed
// (value, not typed form: "3.50" is 3.5); a QWord is never a number, because vertical bars quote the characters.
export function numberValue(x) {
  if (typeof x === 'number') return x;
  if (typeof x === 'string') return parseNumber(x);
  return null;
}

// Builds a list from a JS array (optionally ending in `tail`, a list). The usual way to produce a list result.
export function listFromArray(items, tail = NIL) {
  let l = tail;
  for (let i = items.length - 1; i >= 0; i--) l = new Cell(items[i], l);
  return l;
}

export function list(...items) { return listFromArray(items); }

// A list's members as a JS array. Throws nothing; a non-list yields []. Use for a list you know is proper and finite.
export function listToArray(l) {
  const out = [];
  for (; l instanceof Cell; l = l.rest) out.push(l.first);
  return out;
}

export function listLength(l) {
  let n = 0;
  for (; l instanceof Cell; l = l.rest) n++;
  return n;
}

// Case-insensitive name key. Names of procedures, variables and property lists are case-insensitive (manual,
// TOKENIZATION) while the case typed is preserved wherever the name is shown.
export const nameKey = (text) => text.toLowerCase();

// EQUALP (LOGO.md 4.1 and 11.5 item 4): two numbers are equal by value, and so are two words that are numbers
// ("3" and 3.0); other words compare caseless (CASEIGNOREDP is TRUE initially); lists compare member by member;
// arrays are equal only to themselves. `caseless` is false for the `.EQ`-style and the case-sensitive callers.
export function equalp(a, b, caseless = true) {
  if (isWord(a) && isWord(b)) {
    const na = numberValue(a), nb = numberValue(b);
    if (na !== null && nb !== null) return na === nb;
    const ta = wordText(a), tb = wordText(b);
    return caseless ? ta.toLowerCase() === tb.toLowerCase() : ta === tb;
  }
  if (isList(a) && isList(b)) {
    for (;;) {
      if (a === NIL || b === NIL) return a === b;
      if (!equalp(a.first, b.first, caseless)) return false;
      a = a.rest; b = b.rest;
    }
  }
  return a === b;
}

// Characters that make a word need vertical bars to survive being printed and read back (whitespace, brackets, braces,
// parentheses, tilde, semicolon, vertical bar, backslash). Used by printers that show words readably.
export const NEEDS_BARS_RE = /[\s\[\]{}()~;|\\]/;
