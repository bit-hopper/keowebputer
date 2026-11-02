// TREEIFY (LOGO.md 5.1, plm 3.6d): groups the flat runparsed tokens of an instruction list into expression trees, using
// the CURRENT arity of every procedure it meets. This is the step that makes Logo's "no parentheses around calls" work:
// `print sum 1 2` is print(sum(1,2)) only because sum takes two inputs, which is looked up here, at the time the list is
// about to run. A line is therefore parsed late, and re-parsed if a procedure's arity changes (the interpreter's `epoch`,
// see interpreter.js getTree).
//
// Node shapes (all plain objects; `t` is the discriminator the machine switches on):
//   {t: CONST, v}                 a literal: number, quoted word, list or array (a list literal is the SAME object every time)
//   {t: VAR,   key, name}         :name  (key is the lowercased name; name is as typed, for messages)
//   {t: CALL,  key, name, args, short, err, line}
//                                 a procedure call. `short` is set when the line ran out of inputs; `err` carries an
//                                 arity error found for a parenthesised call. Both are RAISED WHEN THE CALL IS RUN, not
//                                 here, so the instructions before it on the line still execute (the reference raises
//                                 them before running anything; the difference is only visible with side effects).
//   {t: ERR,   error}             a syntax problem (stray `)`, missing `)`): raises when reached.
// `line` on a top-level instruction node of a procedure body points at the body line (a list) so an error can say
// "in <proc>" and show the line.
//
// Grammar, loosest binding first (all left associative; `--` is the hidden tight subtraction runparse creates for a
// monadic minus):   comparison  = < > <= >= <>     additive  + -     multiplicative  * /     tight  --
// Infix operators bind tighter than a procedure's prefix inputs: in `sum 1 2 * 3` the second input is `2 * 3`.
// A "-" where an operand is expected right after another operator (`2 * - 3`) is negation, as the reference does.

import { QWord } from './data.js';
import { INFIX } from './runparse.js';
import { parseNumber } from './numbers.js';
import { err, LogoError } from './errors.js';

export const N = { CONST: 0, VAR: 1, CALL: 2, ERR: 3 };

const COMPARE = new Set(['=', '<', '>', '<=', '>=', '<>']);

const constNode = (v) => ({ t: N.CONST, v });
const errNode = (error) => ({ t: N.ERR, error });
const callNode = (name, args) => ({ t: N.CALL, key: name.toLowerCase(), name, args, short: false, err: null, line: null });

// Treeify `tokens` (from runparse) into an array of instruction nodes. `arityOf(key)` returns {min, def, max} (max -1 =
// unlimited) for a known procedure or primitive, or null for an unknown name (treated as taking no inputs; the call then
// fails at run time with "I don't know how to"). Never throws: problems become ERR nodes or flags on call nodes.
export function treeify(tokens, arityOf) {
  let p = 0;
  const nodes = [];

  const peek = () => tokens[p];

  // A token that can begin an operand, as opposed to an infix operator, ")" or the end of the line.
  function canStartOperand(t) {
    if (t === undefined) return false;
    if (typeof t !== 'string') return true;
    if (t === ')') return false;
    if (INFIX.has(t)) return false;
    return true;
  }

  function parseExpr() { return parseCompare(); }

  function parseCompare() {
    let left = parseAdditive(false);
    if (left === null) return null;
    while (typeof peek() === 'string' && COMPARE.has(peek())) {
      const op = tokens[p++];
      const right = parseAdditive(true);
      if (right === null) return missingOperand(left, op);
      left = callNode(op, [left, right]);
    }
    return left;
  }

  function parseAdditive(afterOp) {
    let left = parseMultiplicative(afterOp);
    if (left === null) return null;
    while (peek() === '+' || peek() === '-') {
      const op = tokens[p++];
      const right = parseMultiplicative(true);
      if (right === null) return missingOperand(left, op);
      left = callNode(op, [left, right]);
    }
    return left;
  }

  function parseMultiplicative(afterOp) {
    let left = parseTight(afterOp);
    if (left === null) return null;
    while (peek() === '*' || peek() === '/') {
      const op = tokens[p++];
      const right = parseTight(true);
      if (right === null) return missingOperand(left, op);
      left = callNode(op, [left, right]);
    }
    return left;
  }

  function parseTight(afterOp) {
    let left = parsePrimary(afterOp);
    if (left === null) return null;
    while (peek() === '--') {
      p++;
      const right = parsePrimary(true);
      if (right === null) return missingOperand(left, '--');
      left = callNode('--', [left, right]);
    }
    return left;
  }

  // An infix operator with nothing after it: a call that is missing an input, raised when run like any other.
  function missingOperand(left, op) {
    const c = callNode(op, [left]);
    c.short = true;
    return c;
  }

  // `afterOp`: this operand directly follows an infix operator, which is the only place a bare "-" means negation.
  function parsePrimary(afterOp) {
    const t = tokens[p];
    if (t === undefined) return null;

    if (typeof t !== 'string') {
      p++;
      if (t instanceof QWord) {
        // A barred word keeps its characters whole. With a leading quote or colon it is still a quoted word or a
        // variable ("|a b|, :|my var|); otherwise it is a procedure name that happens to contain special characters.
        const c = t.text.charCodeAt(0);
        if (c === 34) return constNode(new QWord(t.text.slice(1), t.viaBackslash));
        if (c === 58) { const name = t.text.slice(1); return { t: N.VAR, key: name.toLowerCase(), name }; }
        return parseCall(t.text, true);
      }
      return constNode(t);   // a list or array literal is data
    }

    if (t === '-' && afterOp) {
      p++;
      const operand = parsePrimary(true);
      if (operand === null) return missingOperand(constNode(0), '--');
      return callNode('--', [constNode(0), operand]);
    }

    if (t === ')' || INFIX.has(t)) return null;

    if (t === '(') return parseParen();

    const c0 = t.charCodeAt(0);
    if (c0 === 34 /* " */) { p++; return constNode(t.slice(1)); }
    if (c0 === 58 /* : */) {
      p++;
      const name = t.slice(1);
      return { t: N.VAR, key: name.toLowerCase(), name };
    }
    const num = parseNumber(t);
    if (num !== null) { p++; return constNode(num); }

    p++;
    return parseCall(t, false);
  }

  // A call without parentheses: take exactly the default number of inputs. The name token is already consumed.
  function parseCall(name, barred) {
    const key = name.toLowerCase();
    const ar = arityOf(key);
    const node = callNode(name, []);
    // An error message shows a protected name in bars, as the reference does ("I don't know how  to |1+2|").
    if (barred) node.shown = '|' + name + '|';
    const want = ar ? ar.def : 0;
    for (let k = 0; k < want; k++) {
      if (!canStartOperand(tokens[p])) { node.short = true; break; }
      const a = parseExpr();
      if (a === null) { node.short = true; break; }
      node.args.push(a);
    }
    return node;
  }

  // "(" has been seen but not consumed. Either a call with an explicit number of inputs, `(sum 1 2 3)`, or plain grouping.
  function parseParen() {
    p++;   // the "("
    const t = tokens[p];
    if (t === undefined) return errNode(new LogoError(10, "too many ('s"));
    const isName = (typeof t === 'string' && t !== '(' && t !== ')' && !INFIX.has(t) &&
                    t.charCodeAt(0) !== 34 && t.charCodeAt(0) !== 58 && parseNumber(t) === null) || t instanceof QWord;
    // `(name <infix operator> ...)` is plain grouping, not the explicit-inputs call form: `(three - 1)`, `(repcount - 1)`,
    // `(# + 1)`, `(three = 3)` are expressions whose first operand is a call with its default inputs (the reference reads
    // them so; csls `math` writes `(#-1)` in a template). The call form only starts a group when what follows the name
    // is not an operator. A unary minus is not an operator here: runparse has already turned `-b` into `0 -- b`.
    const nx = tokens[p + 1];
    const infixNext = typeof nx === 'string' && INFIX.has(nx);
    if (isName && !infixNext) {
      const name = t instanceof QWord ? t.text : t;
      p++;
      const node = callNode(name, []);
      while (p < tokens.length && tokens[p] !== ')') {
        const a = parseExpr();
        if (a === null) break;
        node.args.push(a);
      }
      if (tokens[p] === ')') p++;
      else node.err = new LogoError(10, "too many ('s");
      const ar = arityOf(node.key);
      if (!node.err && ar) {
        if (node.args.length < ar.min) node.err = err.tooFew(node.name);
        else if (ar.max >= 0 && node.args.length > ar.max) node.err = err.tooMany(node.name);
      }
      return node;
    }
    const inner = parseExpr();
    if (inner === null) {
      if (tokens[p] === ')') { p++; return errNode(err.noPlan('(')); }
      return errNode(new LogoError(10, "too many ('s"));
    }
    if (tokens[p] === ')') { p++; return inner; }
    // More tokens before the ")": `(3 4)`. Report the missing paren and drop the rest of the group.
    while (p < tokens.length && tokens[p] !== ')') p++;
    if (tokens[p] === ')') p++;
    return errNode(new LogoError(10, "too many ('s"));
  }

  while (p < tokens.length) {
    const t = tokens[p];
    if (t === ')') { p++; nodes.push(errNode(err.closeParen())); continue; }
    const before = p;
    const e = parseExpr();
    if (e === null) {
      // An infix operator where an instruction should begin: nothing to do with it.
      p = Math.max(p, before + 1);
      nodes.push(errNode(err.noPlan(typeof t === 'string' ? t : '?')));
      continue;
    }
    nodes.push(e);
  }
  return nodes;
}
