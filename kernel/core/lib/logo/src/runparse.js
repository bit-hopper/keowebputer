// RUNPARSE (LOGO.md 4.1, plm 3.6a-c): the second tokenization, applied to a list when it is about to be RUN as code.
// Input is the members of a list as the reader produced them; output is a flat JS array of TOKENS in which
//   * parentheses and infix operators are split out of words ("5-2" -> 5 - 2, "(sum" -> ( sum, ":n-1" -> :n - 1),
//   * a monadic minus becomes the two tokens 0 -- (the hidden tight-binding subtraction),
//   * a "?37" becomes ( ? 37 ),
//   * everything that is not an unquoted string word passes through unchanged: lists and arrays (data), and QWords
//     (barred / backslashed words, which must stay whole).
//
// Token kinds, by JS type, so treeify.js can tell them apart without wrappers:
//   string starting with "  quoted word literal      string starting with :  variable reference
//   string "(" or ")"       a real parenthesis        string in INFIX         a real infix operator
//   any other string        a number or a procedure name
//   QWord                   a protected word (never an operator, never a parenthesis; it is a name or data)
//   Cell / NIL / LArray     a list or array literal
//
// The minus rules (plm 3.6b), in terms of the words of the list (words are separated by spaces, so "begins a word"
// means "follows a space"):
//   -3  at the start of a word, or right after "(" or an operator, with a digit next   -> the number -3
//   -b  at the start of a word or right after "(", with something else next            -> 0 -- b   (monadic)
//   -   a word by itself, or after an operand (a-b)                                    -> the infix operator -
//   *-b right after another operator, not followed by a digit                          -> a plain "-" token; the
//       treeifier reads a "-" in operand position as negation (plm: `runparse [a*-b]` is `[a * - b]`)
//
// This is a pure function of its input. Do not mutate the input list. Cache results (treeify's tree cache does).

import { parseNumber } from './numbers.js';

export const INFIX = new Set(['+', '-', '*', '/', '=', '<', '>', '<=', '>=', '<>', '--']);

const OPERATOR_CHARS = '+-*/=<>';
const isOp = (c) => OPERATOR_CHARS.indexOf(c) !== -1;
const isDigit = (c) => c >= '0' && c <= '9';

// A number can start with a digit or with ".digit". Used for the negative-number-token rule.
function startsNumber(s, i) {
  if (i >= s.length) return false;
  if (isDigit(s[i])) return true;
  return s[i] === '.' && i + 1 < s.length && isDigit(s[i + 1]);
}

// Splits one unquoted string word into tokens, appending to `out`. A word always starts after a space or a list
// boundary, which is what the minus rules key on.
function splitWord(w, out) {
  // A whole-word number (including exponent form) needs no splitting.
  if (parseNumber(w) !== null) { out.push(w); return; }

  const base = out.length;   // tokens already emitted before this word: "nothing emitted yet" means word start
  let chunk = '';
  // A chunk like ?37 is the template slot call ( ? 37 ) (manual, TOKENIZATION): it can sit against a parenthesis, as in (?1).
  const flush = () => {
    if (chunk === '') return;
    if (/^\?\d+$/.test(chunk)) out.push('(', '?', chunk.slice(1), ')'); else out.push(chunk);
    chunk = '';
  };
  const last = () => out.length ? out[out.length - 1] : null;
  
  for (let i = 0; i < w.length;) {
    const c = w[i];
    if (c === '(' || c === ')') { flush(); out.push(c); i++; continue; }

    if (isOp(c)) {
      // Exponent sign inside a number being built: 1e-3, 2.5E+4.
      if ((c === '-' || c === '+') && /^\.?\d[\d.]*[eE]$/.test(chunk) && startsNumber(w, i + 1)) {
        chunk += c; i++;
        while (i < w.length && isDigit(w[i])) chunk += w[i++];
        continue;
      }
      if (c === '-') {
        const atWordStart = chunk === '' && out.length === base;
        const prev = last();
        const afterOpenParen = chunk === '' && prev === '(';
        const afterInfix = chunk === '' && typeof prev === 'string' && INFIX.has(prev);
        if (chunk === '' && (atWordStart || afterOpenParen || afterInfix)) {
          if (startsNumber(w, i + 1)) { chunk = '-'; i++; continue; }          // -3  (negative number token)
          if (atWordStart && i + 1 >= w.length) { out.push('-'); i++; continue; } // a word that is only "-": subtraction
          if (afterInfix) { out.push('-'); i++; continue; }                     // a*-b: leave it for the treeifier
          out.push('0', '--'); i++; continue;                                   // -b at a word start: monadic minus
        }
        flush(); out.push('-'); i++; continue;                                  // a-b: dyadic
      }
      // Two-character comparison operators.
      flush();
      if ((c === '<' || c === '>') && w[i + 1] === '=') { out.push(c + '='); i += 2; continue; }
      if (c === '<' && w[i + 1] === '>') { out.push('<>'); i += 2; continue; }
      out.push(c); i++; continue;
    }

    chunk += c; i++;
  }
  flush();
}

// Runparse the members of a list (a JS array of data). Returns the flat token array.
export function runparse(items) {
  const out = [];
  for (const it of items) {
    if (typeof it !== 'string') { out.push(it); continue; }   // QWord, number, list, array: pass through whole
    if (it.charCodeAt(0) === 34 /* " */) {
      // A quoted word: delimited by parentheses only, and the first character after the quote is always part of it
      // (so `"(` is the word "(", as in the manual's examples).
      let j = 2;
      while (j < it.length && it[j] !== '(' && it[j] !== ')') j++;
      if (j >= it.length) { out.push(it); continue; }
      out.push(it.slice(0, j));
      // The rest (parentheses and whatever follows) is ordinary text again.
      splitWord(it.slice(j), out);
      continue;
    }
    splitWord(it, out);
  }
  return out;
}
