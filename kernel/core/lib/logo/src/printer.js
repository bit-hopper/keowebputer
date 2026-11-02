// Printing Logo data (LOGO.md 5.6; manual, PRINT / SHOW / TYPE; 11.5 item 2 and 4).
//
//   print  words as typed; a list WITHOUT its outer brackets, inner lists with theirs   print [a [b c] d]  ->  a [b c] d
//   show   everything with its brackets                                                 show  [a [b c] d]  ->  [a [b c] d]
//   type   like print, no newline
// Numbers print per numbers.js formatNumber; a word that merely looks like a number prints as typed. An array prints in
// braces ({1 2 3}); the reference does not print the origin (11.5: `show {1 2 3}@5` and `show (array 3 0)` print bare braces).
//
// `showForm` is what error messages embed for a value ("first doesn't like [] as input"); it additionally writes the
// empty word as || as the reference does. Do not use these to build words (WORD, SENTENCE ...): those work on the data.

import { Cell, NIL, LArray, QWord, isList, wordText, numberValue } from './data.js';

// One datum inside a list or array: lists and arrays bracketed, words as text. A barred word prints WITHOUT its bars, as
// the reference does (print [a |b c|] shows a b c).
function item(x) {
  if (x instanceof Cell || x === NIL) return '[' + members(x) + ']';
  if (x instanceof LArray) return arrayText(x);
  return wordText(x);
}

function members(l) {
  const parts = [];
  for (; l instanceof Cell; l = l.rest) parts.push(item(l.first));
  return parts.join(' ');
}

function arrayText(a) {
  return '{' + a.items.map(item).join(' ') + '}';
}

// show-style text of any datum.
export function showText(x) {
  if (x instanceof Cell || x === NIL) return '[' + members(x) + ']';
  if (x instanceof LArray) return arrayText(x);
  return wordText(x);
}

// print-style text: a list loses its outer brackets only.
export function printText(x) {
  if (x instanceof Cell || x === NIL) return members(x);
  if (x instanceof LArray) return arrayText(x);
  return wordText(x);
}

// For error messages: show-style, with the empty word written as ||.
export function showForm(x) {
  if (typeof x === 'string' && x === '') return '||';
  if (x === undefined) return '';
  return showText(x);
}

// ---- PO's form: text that reads back as the same data ---------------------------------------------------------------
// PO prints a variable as  Make "name value  and a property as  Pprop "plist "prop value. Observed on the reference
// (6.2.5, 2026-10-23, tests/logo/seed/po-format.lg), unlike SHOW:
//   - a number, or a word that reads as one, prints bare; any other top-level word value gets a leading quote; the empty
//     word is ||;
//   - a word typed with vertical bars (a QWord) prints in bars when it has anything but letters, digits and _ . ? !  (so
//     |abc| prints as abc, |a;b|, |a"b| and |-| keep their bars);
//   - any other word with a delimiting character gets a backslash before each one (top level: space ; ~ [ ] ( ) { } | \ ;
//     inside a list or array only space ; ~ [ ] | \, because a list literal's (f) and {g} are ordinary words);
//   - names print in bars when they contain a delimiter (they are stored without their typed form).
// KNOWN DIFFERENCE: the reference prints a word typed with a backslash INSIDE A LIST LITERAL ([a\;b]) in bars, but the same
// word built with  "a\;b  with a backslash; our reader keeps no such distinction, so both print with the backslash here. (LOGO.md 15.3 item 9.)
// Do not use these to build words, and do not use them for SHOW/PRINT/TYPE (those never add protection).
const BS = String.fromCharCode(92);   // a backslash
const TOP_DELIMITERS = ' ;~[](){}|' + BS;
const ITEM_DELIMITERS = ' ;~[]|' + BS;
const BAR_SPECIALS = '|' + BS;
const PLAIN_IN_BARS = /^[A-Za-z0-9_.?!]*$/;

const hasAny = (text, chars) => [...text].some((c) => chars.includes(c));
// `text` with a backslash before every character that is in `chars`.
const backslash = (text, chars) => [...text].map((c) => (chars.includes(c) ? BS + c : c)).join('');

// A word's text with the protection it needs to be typed again (see above); `delimiters` is TOP_ or ITEM_DELIMITERS.
function protect(x, delimiters) {
  const text = wordText(x);
  if (x instanceof QWord && x.viaBackslash) return backslash(text, delimiters);
  if (x instanceof QWord) return PLAIN_IN_BARS.test(text) ? text : '|' + backslash(text, BAR_SPECIALS) + '|';
  return hasAny(text, delimiters) ? backslash(text, delimiters) : text;
}

function* listMembers(l) {
  for (; l instanceof Cell; l = l.rest) yield l.first;
}

function poItem(x) {
  if (x instanceof Cell || x === NIL) return '[' + [...listMembers(x)].map(poItem).join(' ') + ']';
  if (x instanceof LArray) return '{' + x.items.map(poItem).join(' ') + '}';
  return protect(x, ITEM_DELIMITERS);
}

// The value operand of Make / Pprop.
export function poValue(x) {
  if (x instanceof Cell || x === NIL || x instanceof LArray) return poItem(x);
  if (typeof x === 'number' || numberValue(x) !== null) return wordText(x);
  return wordText(x) === '' ? '"||' : '"' + protect(x, TOP_DELIMITERS);
}

// A variable or property-list name as the operand of Make / Pprop.
export function poName(name) {
  return '"' + (hasAny(name, TOP_DELIMITERS) ? '|' + backslash(name, BAR_SPECIALS) + '|' : name);
}

export { isList };
