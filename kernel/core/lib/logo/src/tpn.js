// Turtle Procedure Notation (LOGO.md 4.3, the book's Appendix A): the surface syntax of the `tpn` cells. It is analysed into
// the SAME node trees the Logo path produces (treeify.js: CONST / VAR / CALL), so the machine, the primitives and the
// error machinery are shared and an error points at the TPN line, not at some Logo text made from it.
//
// What the notation looks like (the page images, Appendix A pp. 393-403, were read for this):
//   TO NAME a b c            a title line; the body is the lines indented under it; no END. A procedure name may contain
//   TO NAME (A, B, [V W])    dots, inputs may be separated by commas and wrapped in parentheses, and an input written as a
//                            list is destructured (`[V W]`).
//   X <- expr                assignment (the book prints a left arrow; `<-` and the arrow glyph are both accepted).
//   [A B] <- L               structure-directed assignment.
//   RETURN expr | RETURN | STOP
//   IF c THEN a ELSE b       one line, or THEN / ELSE each followed by an indented block (or alone on a line above one).
//   REPEAT n | FOREVER | UNTIL c | FOR I = X TO Y | FOR I IN list      followed by an indented block;
//   REPEAT  block  UNTIL c   tests after the block.
//   F(a, b)   F a b          a call with parenthesised, comma separated inputs, or the Logo way (as many inputs as F takes).
//   [1 (3+5) 7]              a list whose items are EVALUATED expressions (1, 8, 7).
//   Variables are bare names; a name that is a procedure takes inputs. Which is which is decided when a body is analysed:
//   inputs and every name assigned anywhere in the same procedure are variables, everything else is a call (and a call to
//   a name nothing defines falls back to a global variable of that name at run time, as bare names do in Logo cells).
//
// Dialect rules worth knowing before changing anything here:
//  * A TPN procedure may share its name with a Logo primitive (the book defines its own SUM, SQRT, ABS ...). Such a
//    procedure lives under the key `tpn:name` and is seen by TPN code only, so a Logo cell (and the prelude) keeps the
//    primitive. TPN's own built-ins whose meaning differs from Logo's (ITEM(L, N), REST, BOTH, EITHER ...) are records under
//    the same `tpn:` keys; a TPN `TO ITEM` replaces one. A name with no `tpn:` record is the ordinary Logo one.
//  * A block (the body of a REPEAT, the branches of an IF) is a Logo LIST whose tree is registered in the interpreter's
//    tree cache as fixed (interpreter.js getTree), so every control primitive that runs a list (repeat, ifelse, until, for,
//    foreach ...) runs it unchanged, including STOP / OUTPUT leaving the procedure through it.
//  * A parenthesis straight after a name (`ABS(X - 1)`) or a parenthesised group containing a comma (`REMAINDER (T, 360)`)
//    is that call's complete input list and the call is then an operand (`ABS(X) < .001` compares the absolute value). A
//    group with a space before it and no comma is plain grouping, so `PRINT (SQRT 144) + (SQRT 144)` prints the sum. This is
//    the rule that makes every example in the appendix come out as printed; the appendix does not state it.
//
// Source here is ASCII on purpose; the arrow and the other glyphs are written as escapes.

import { Cell, NIL, isList, listFromArray, listToArray, nameKey } from './data.js';
import { N } from './treeify.js';
import { LogoError, err } from './errors.js';
import { Proc } from './machine.js';
import { isPrimRecord, num } from './prims.js';
import { showForm } from './printer.js';

const TPN_SYNTAX = 40;
const syntax = (msg) => new LogoError(TPN_SYNTAX, msg);

// ---------------------------------------------------------------------------------------------------------------------
// Lines and indentation

// Splits one physical line into its code (comment removed, trailing blanks dropped) and the number of brackets it leaves
// open. A semicolon or a bracket inside a string means nothing.
function cleanLine(raw) {
  let inStr = false, depth = 0, out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') inStr = !inStr;
    else if (!inStr) {
      if (ch === ';') break;
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
    }
    out += ch;
  }
  return { code: out.replace(/\s+$/, ''), depth };
}

function indentOf(raw) {
  let w = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === ' ') w++;
    else if (raw[i] === '\t') w = (Math.floor(w / 8) + 1) * 8;
    else break;
  }
  return w;
}

// The logical lines of a source text: {indent, text, raw, children, tokens}. A blank or comment-only line is dropped (its
// indentation means nothing); a line with an unclosed bracket continues onto the next one.
export function readLines(source) {
  const physical = source.replace(/\r\n?/g, '\n').split('\n');
  const lines = [];
  let open = null;
  for (let n = 0; n < physical.length; n++) {
    const raw = physical[n];
    const { code, depth } = cleanLine(raw);
    if (open !== null) {
      open.text += ' ' + code.trim();
      open.raw += '\n' + raw;
      open.depth += depth;
      if (open.depth <= 0) { lines.push(open); open = null; }
      continue;
    }
    if (code.trim() === '') continue;
    const line = { indent: indentOf(raw), text: code.trim(), raw, depth, children: [], tokens: null };
    if (depth > 0) open = line; else lines.push(line);
  }
  if (open !== null) lines.push(open);
  return lines;
}

// Nests the lines by indentation: each line's children are the following lines indented deeper than it.
export function buildTree(lines) {
  const root = { indent: -1, children: [] };
  const stack = [root];
  for (const l of lines) {
    while (stack[stack.length - 1].indent >= l.indent) stack.pop();
    stack[stack.length - 1].children.push(l);
    stack.push(l);
  }
  return root.children;
}

const isToText = (text) => /^to(\s|$)/i.test(text);

// The units of a cell: a procedure definition, or a run of consecutive statements (one unit so an IF at the top level can
// find its ELSE line).
export function splitUnits(roots) {
  const units = [];
  let run = null;
  for (const line of roots) {
    if (isToText(line.text)) {
      run = null;
      units.push({ kind: 'to', line });
    } else {
      if (run === null) { run = { kind: 'run', lines: [] }; units.push(run); }
      run.lines.push(line);
    }
  }
  return units;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tokens

const NUM_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const NAME_RE = /[A-Za-z_][A-Za-z0-9_.?']*/y;

// Token: {k: 'num'|'str'|'name'|'op'|'arrow'|'punct', v, sp: a blank before it, nsp: a blank (or the end) after it}.
function tokenize(text) {
  const toks = [];
  const n = text.length;
  const isSp = (c) => c === ' ' || c === '\t';
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (isSp(c)) { i++; continue; }
    const start = i;
    let tok;
    if (c === '"') {
      const j = text.indexOf('"', i + 1);
      if (j < 0) throw syntax('missing closing " for a string');
      tok = { k: 'str', v: text.slice(i + 1, j) };
      i = j + 1;
    } else if ((c >= '0' && c <= '9') || (c === '.' && text[i + 1] >= '0' && text[i + 1] <= '9')) {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(text);
      tok = { k: 'num', v: Number(m[0]) };
      i += m[0].length;
    } else if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
      NAME_RE.lastIndex = i;
      const m = NAME_RE.exec(text);
      tok = { k: 'name', v: m[0] };
      i += m[0].length;
    } else if (c === '\u2190') { tok = { k: 'arrow', v: '<-' }; i++; }
    else if (c === '<' && text[i + 1] === '-') { tok = { k: 'arrow', v: '<-' }; i += 2; }
    else if (c === '<' && text[i + 1] === '=') { tok = { k: 'op', v: '<=' }; i += 2; }
    else if (c === '>' && text[i + 1] === '=') { tok = { k: 'op', v: '>=' }; i += 2; }
    else if (c === '<' && text[i + 1] === '>') { tok = { k: 'op', v: '<>' }; i += 2; }
    else if (c === '\u2264') { tok = { k: 'op', v: '<=' }; i++; }
    else if (c === '\u2265') { tok = { k: 'op', v: '>=' }; i++; }
    else if (c === '\u2260') { tok = { k: 'op', v: '<>' }; i++; }
    else if (c === '\u2191') { tok = { k: 'op', v: '^' }; i++; }
    else if (c === '\u00d7') { tok = { k: 'op', v: '*' }; i++; }
    else if (c === '\u00f7') { tok = { k: 'op', v: '/' }; i++; }
    else if ('+-*/^=<>'.indexOf(c) >= 0) { tok = { k: 'op', v: c }; i++; }
    else if ('()[],'.indexOf(c) >= 0) { tok = { k: 'punct', v: c }; i++; }
    else throw syntax("I don't understand the character " + c);
    tok.sp = start === 0 || isSp(text[start - 1]);
    tok.nsp = i >= n || isSp(text[i]);
    toks.push(tok);
  }
  return toks;
}

const tokensOf = (line) => (line.tokens !== null ? line.tokens : (line.tokens = tokenize(line.text)));

const tokenText = (t) => (t.k === 'str' ? '"' + t.v + '"' : String(t.v));

// Index of the ] that closes the [ at toks[i], or -1.
function matchBracket(toks, i) {
  let depth = 0;
  for (let k = i; k < toks.length; k++) {
    const t = toks[k];
    if (t.k !== 'punct') continue;
    if (t.v === '[') depth++;
    else if (t.v === ']') { depth--; if (depth === 0) return k; }
  }
  return -1;
}

const isKw = (t, kw) => t !== undefined && t.k === 'name' && t.v.toUpperCase() === kw;
const RESERVED = new Set(['THEN', 'ELSE', 'UNTIL', 'TO', 'IN']);
const isReserved = (t) => t.k === 'name' && RESERVED.has(t.v.toUpperCase());

// A pattern `[A [B C] D]` as nested Logo lists of names (commas ignored).
function patternList(toks, from, to) {
  const items = [];
  for (let i = from; i < to; i++) {
    const t = toks[i];
    if (t.k === 'name') items.push(t.v);
    else if (t.k === 'punct' && t.v === ',') continue;
    else if (t.k === 'punct' && t.v === '[') {
      const close = matchBracket(toks, i);
      if (close < 0 || close > to) throw syntax("missing ']'");
      items.push(patternList(toks, i + 1, close));
      i = close;
    } else throw syntax('a name was expected in [...] before the arrow, not ' + tokenText(t));
  }
  return listFromArray(items);
}

function patternNames(pattern, out) {
  for (const x of listToArray(pattern)) { if (isList(x)) patternNames(x, out); else out.add(nameKey(x)); }
}

// Every name a body assigns: the target of an arrow, a destructuring pattern, a REPEAT FOR variable, a LOCAL. These are
// variables wherever they are read in the same procedure.
function scanAssigned(toks, set) {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === 'arrow') {
      const prev = toks[i - 1];
      if (prev === undefined) continue;
      if (prev.k === 'name') set.add(nameKey(prev.v));
      else if (prev.k === 'punct' && prev.v === ']') {
        let depth = 0, open = -1;
        for (let k = i - 1; k >= 0; k--) {
          if (toks[k].k !== 'punct') continue;
          if (toks[k].v === ']') depth++;
          else if (toks[k].v === '[') { depth--; if (depth === 0) { open = k; break; } }
        }
        if (open >= 0) patternNames(patternList(toks, open + 1, i - 1), set);
      }
    } else if (t.k === 'name') {
      const up = t.v.toUpperCase();
      if (up === 'FOR' && isKw(toks[i - 1], 'REPEAT') && toks[i + 1] !== undefined && toks[i + 1].k === 'name') set.add(nameKey(toks[i + 1].v));
      else if (up === 'LOCAL') for (let k = i + 1; k < toks.length && (toks[k].k === 'name' || (toks[k].k === 'punct' && toks[k].v === ',')); k++) if (toks[k].k === 'name') set.add(nameKey(toks[k].v));
    }
  }
}

function prescan(lines, set) {
  for (const l of lines) { scanAssigned(tokensOf(l), set); prescan(l.children, set); }
}

// ---------------------------------------------------------------------------------------------------------------------
// Nodes

const constNode = (v) => ({ t: N.CONST, v });
const callNode = (key, name, args = []) => ({ t: N.CALL, key, name, args, short: false, err: null, line: null });

// The block a body or branch becomes: a list the control primitives can run, whose tree is registered as ready-made.
function makeBlock(interp, nodes) {
  const cell = new Cell('tpn-block', NIL);
  interp.treeCache.set(cell, { epoch: 0, fixed: true, nodes });
  return cell;
}

const lineWords = (line) => listFromArray(line.text.split(/\s+/));

// Where a name is looked up: a TPN record (`tpn:name`) first, else the ordinary table.
function resolve(interp, name) {
  const k = nameKey(name);
  const t = interp.procs.get('tpn:' + k);
  if (t !== undefined) return t;
  const p = interp.procs.get(k);
  return p === undefined ? null : p;
}

// ---------------------------------------------------------------------------------------------------------------------
// Expressions and simple statements

const COMPARE = new Set(['=', '<', '>', '<=', '>=', '<>']);

class Parser {
  constructor(toks, ctx) { this.t = toks; this.i = 0; this.ctx = ctx; this.listDepth = 0; }

  peek(o = 0) { return this.t[this.i + o]; }
  atEnd() { return this.i >= this.t.length; }
  peekKw(kw) { return isKw(this.peek(), kw); }
  isPunct(t, v) { return t !== undefined && t.k === 'punct' && t.v === v; }

  canStartOperand(t) {
    if (t === undefined) return false;
    if (t.k === 'num' || t.k === 'str') return true;
    if (t.k === 'punct') return t.v === '[' || t.v === '(';
    if (t.k === 'name') return !isReserved(t);
    return t.k === 'op' && t.v === '-';
  }

  // ---- statements ----

  // Statements to the end of the line, or up to the keyword `stopKw`.
  parseStatements(stopKw) {
    const out = [];
    while (!this.atEnd()) {
      if (stopKw !== undefined && this.peekKw(stopKw)) break;
      this.parseOne(out);
    }
    return out;
  }

  parseOne(out) {
    const t = this.peek();
    if (t.k === 'name') {
      const kw = t.v.toUpperCase();
      if (kw === 'RETURN') {
        this.i++;
        const nx = this.peek();
        if (nx === undefined || isReserved(nx)) out.push(callNode('stop', 'STOP'));
        else out.push(callNode('output', 'RETURN', [this.parseExpr()]));
        return;
      }
      if (kw === 'LOCAL') {
        this.i++;
        const args = [];
        while (this.peek() !== undefined && (this.peek().k === 'name' || this.isPunct(this.peek(), ','))) {
          const a = this.t[this.i++];
          if (a.k === 'name') args.push(constNode(a.v));
        }
        out.push(callNode('local', 'LOCAL', args));
        return;
      }
      if (kw === 'IF') { this.parseInlineIf(out); return; }
      if (kw === 'REPEAT') throw syntax('REPEAT has to begin its own line');
      if (kw === 'THEN' || kw === 'ELSE' || kw === 'UNTIL') throw syntax('unexpected ' + kw);
      if (this.peek(1) !== undefined && this.peek(1).k === 'arrow') {
        this.i += 2;
        out.push(callNode('make', 'make', [constNode(t.v), this.parseExpr()]));
        return;
      }
    } else if (this.isPunct(t, '[')) {
      const close = matchBracket(this.t, this.i);
      if (close > 0 && this.t[close + 1] !== undefined && this.t[close + 1].k === 'arrow') {
        const pattern = patternList(this.t, this.i + 1, close);
        this.i = close + 2;
        out.push(callNode('tpn:destructure', '<-', [constNode(pattern), this.parseExpr(), constNode('set')]));
        return;
      }
    }
    out.push(this.parseExpr());
  }

  // `IF c [THEN] stmts [ELSE stmts]` entirely on this line.
  parseInlineIf(out) {
    this.i++;
    const cond = this.parseExpr();
    if (this.peekKw('THEN')) this.i++;
    const thenNodes = this.parseStatements('ELSE');
    let elseNodes = null;
    if (this.peekKw('ELSE')) { this.i++; elseNodes = this.parseStatements(); }
    out.push(ifNode(this.ctx, cond, thenNodes, elseNodes));
  }

  // ---- expressions ----

  parseExpr() { return this.parseCompare(); }

  parseCompare() {
    let left = this.parseAdd();
    for (;;) {
      const t = this.peek();
      if (!(t !== undefined && t.k === 'op' && COMPARE.has(t.v))) break;
      this.i++;
      left = callNode(t.v, t.v, [left, this.parseAdd()]);
    }
    return left;
  }

  // Inside a list, `5 -1` is two items, as in Logo: a minus with a blank before it and none after starts the next item.
  isBinaryMinus(t) { return !(this.listDepth > 0 && t.sp && !t.nsp); }

  parseAdd() {
    let left = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (!(t !== undefined && t.k === 'op' && (t.v === '+' || (t.v === '-' && this.isBinaryMinus(t))))) break;
      this.i++;
      left = callNode(t.v, t.v, [left, this.parseMul()]);
    }
    return left;
  }

  parseMul() {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (!(t !== undefined && t.k === 'op' && (t.v === '*' || t.v === '/'))) break;
      this.i++;
      left = callNode(t.v, t.v, [left, this.parseUnary()]);
    }
    return left;
  }

  // A minus where a value is expected is negation. It binds tighter than * and looser than ^, so -B ^ 2 is -(B ^ 2).
  parseUnary() {
    const t = this.peek();
    if (t !== undefined && t.k === 'op' && t.v === '-') {
      this.i++;
      const x = this.parseUnary();
      if (x.t === N.CONST && typeof x.v === 'number') return constNode(x.v === 0 ? 0 : -x.v);
      return callNode('minus', 'minus', [x]);
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePrimary();
    const t = this.peek();
    if (t !== undefined && t.k === 'op' && t.v === '^') {
      this.i++;
      return callNode('power', '^', [base, this.parseUnary()]);
    }
    return base;
  }

  parsePrimary() {
    const t = this.peek();
    if (t === undefined) throw syntax('the line ends where a value is needed');
    switch (t.k) {
      case 'num': case 'str': this.i++; return constNode(t.v);
      case 'name':
        if (isReserved(t)) throw syntax('unexpected ' + t.v.toUpperCase());
        return this.parseName();
      case 'punct':
        if (t.v === '[') return this.parseListLiteral();
        if (t.v === '(') return this.parseGroup();
        throw syntax("unexpected '" + t.v + "'");
      case 'arrow': throw syntax('unexpected assignment arrow');
      default: throw syntax("unexpected '" + t.v + "'");
    }
  }

  parseGroup() {
    this.i++;
    const saved = this.listDepth;
    this.listDepth = 0;
    if (this.isPunct(this.peek(), ')')) throw syntax('empty parentheses');
    const e = this.parseExpr();
    this.listDepth = saved;
    const c = this.peek();
    if (this.isPunct(c, ')')) { this.i++; return e; }
    if (this.isPunct(c, ',')) throw syntax("a comma only separates the inputs of a call, as in SUM(A, B)");
    throw syntax("missing ')'");
  }

  parseListLiteral() {
    this.i++;
    this.listDepth++;
    const items = [];
    for (;;) {
      const t = this.peek();
      if (t === undefined) throw syntax("missing ']'");
      if (this.isPunct(t, ']')) { this.i++; break; }
      if (this.isPunct(t, ',')) { this.i++; continue; }
      items.push(this.parseExpr());
    }
    this.listDepth--;
    if (items.every((x) => x.t === N.CONST)) return constNode(listFromArray(items.map((x) => x.v)));
    return callNode('list', 'list', items);
  }

  // Is the parenthesis at index `i` a group with a comma directly inside it?
  parenHasComma(i) {
    let depth = 0;
    for (let k = i; k < this.t.length; k++) {
      const t = this.t[k];
      if (t.k !== 'punct') continue;
      if (t.v === '(' || t.v === '[') depth++;
      else if (t.v === ')' || t.v === ']') { depth--; if (depth === 0) return false; }
      else if (t.v === ',' && depth === 1) return true;
    }
    return false;
  }

  parseName() {
    const t = this.t[this.i++];
    const name = t.v, key = nameKey(name);
    if (this.ctx.locals.has(key)) return { t: N.VAR, key, name };
    const rec = resolve(this.ctx.interp, name);
    const node = callNode(rec !== null ? rec.key : key, name);
    const nx = this.peek();
    if (this.isPunct(nx, '(') && (!nx.sp || this.parenHasComma(this.i))) {
      // The whole input list is in the parentheses.
      this.i++;
      const saved = this.listDepth;
      this.listDepth = 0;
      if (!this.isPunct(this.peek(), ')')) {
        for (;;) {
          node.args.push(this.parseExpr());
          if (this.isPunct(this.peek(), ',')) { this.i++; continue; }
          break;
        }
      }
      if (!this.isPunct(this.peek(), ')')) throw syntax("missing ')'");
      this.i++;
      this.listDepth = saved;
      if (rec !== null) {
        if (node.args.length < rec.min) node.err = err.tooFew(name);
        else if (rec.max >= 0 && node.args.length > rec.max) node.err = err.tooMany(name);
      }
      return node;
    }
    if (this.isPunct(nx, '(') && rec !== null && rec.def >= 2) {
      // `RAND ( - A A )`: a spaced group holding several inputs with no comma between them (the book prints one in chapter
      // 2). It is only that when two or more expressions come out of it; one is plain grouping and is parsed below.
      const mark = this.i, saved = this.listDepth;
      this.i++;
      this.listDepth = 0;
      const args = [];
      while (this.canStartOperand(this.peek())) args.push(this.parseExpr());
      this.listDepth = saved;
      if (args.length >= 2 && this.isPunct(this.peek(), ')')) {
        this.i++;
        node.args = args;
        if (args.length > rec.max && rec.max >= 0) node.err = err.tooMany(name);
        return node;
      }
      this.i = mark;
    }
    const want = rec !== null ? rec.def : 0;
    for (let k = 0; k < want; k++) {
      if (!this.canStartOperand(this.peek())) { node.short = true; break; }
      node.args.push(this.parseExpr());
    }
    return node;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Blocks: IF and REPEAT, which own the indented lines under them

function ifNode(ctx, cond, thenNodes, elseNodes) {
  const thenBlock = makeBlock(ctx.interp, thenNodes);
  if (elseNodes === null) return callNode('if', 'IF', [cond, constNode(thenBlock)]);
  return callNode('ifelse', 'IF', [cond, constNode(thenBlock), constNode(makeBlock(ctx.interp, elseNodes))]);
}

const startsWith = (line, kw) => isKw(tokensOf(line)[0], kw);

// What follows the keyword on a line (inline statements) plus the block indented under it.
function partNodes(line, skip, ctx) {
  const p = new Parser(tokensOf(line), ctx);
  p.i = skip;
  const inline = p.atEnd() ? [] : p.parseStatements();
  return inline.concat(compileSiblings(line.children, ctx));
}

function compileIf(lines, i, ctx) {
  const line = lines[i];
  const p = new Parser(tokensOf(line), ctx);
  p.i = 1;
  const cond = p.parseExpr();
  if (p.peekKw('THEN')) p.i++;
  let thenNodes, elseNodes = null, next = i + 1;
  const elseSibling = () => {
    const s = lines[i + 1];
    if (s !== undefined && s.indent === line.indent && startsWith(s, 'ELSE')) { elseNodes = partNodes(s, 1, ctx); next = i + 2; }
  };
  if (!p.atEnd()) {
    if (line.children.length) throw syntax('lines indented under an IF that already has its action on the same line');
    thenNodes = p.parseStatements('ELSE');
    if (p.peekKw('ELSE')) { p.i++; elseNodes = p.parseStatements(); }
    else elseSibling();
  } else {
    const kids = line.children;
    if (kids.length === 0) throw syntax('IF has nothing to do');
    if (startsWith(kids[0], 'THEN')) {
      thenNodes = partNodes(kids[0], 1, ctx);
      let k = 1;
      if (kids[k] !== undefined && startsWith(kids[k], 'ELSE')) { elseNodes = partNodes(kids[k], 1, ctx); k++; }
      if (k < kids.length) throw syntax('unexpected line after THEN / ELSE: ' + kids[k].text);
    } else {
      thenNodes = compileSiblings(kids, ctx);
    }
    if (elseNodes === null) elseSibling();
  }
  return { nodes: [ifNode(ctx, cond, thenNodes, elseNodes)], next };
}

function compileRepeat(lines, i, ctx) {
  const line = lines[i];
  const p = new Parser(tokensOf(line), ctx);
  p.i = 1;
  const body = () => partNodes(line, p.i, ctx);
  const interp = ctx.interp;
  const condBlock = (expr) => makeBlock(interp, [expr]);
  if (p.atEnd()) {
    // REPEAT, a block, then UNTIL c: the test comes after the block.
    const s = lines[i + 1];
    if (s === undefined || s.indent !== line.indent || !startsWith(s, 'UNTIL')) throw syntax('REPEAT needs a count, FOREVER, UNTIL or FOR, or an UNTIL line under its block');
    const sp = new Parser(tokensOf(s), ctx);
    sp.i = 1;
    const cond = sp.parseExpr();
    if (!sp.atEnd()) throw syntax('unexpected ' + tokenText(sp.peek()) + ' after the UNTIL condition');
    const bodyNodes = compileSiblings(line.children, ctx);
    return { nodes: [callNode('do.until', 'REPEAT', [constNode(makeBlock(interp, bodyNodes)), constNode(condBlock(cond))])], next: i + 2 };
  }
  if (p.peekKw('FOREVER')) {
    p.i++;
    return { nodes: [callNode('forever', 'REPEAT', [constNode(makeBlock(interp, body()))])], next: i + 1 };
  }
  if (p.peekKw('UNTIL')) {
    p.i++;
    const cond = p.parseExpr();
    return { nodes: [callNode('until', 'REPEAT', [constNode(condBlock(cond)), constNode(makeBlock(interp, body()))])], next: i + 1 };
  }
  if (p.peekKw('FOR')) {
    p.i++;
    const v = p.peek();
    if (v === undefined || v.k !== 'name') throw syntax('REPEAT FOR needs a variable name');
    p.i++;
    const how = p.peek();
    if (how !== undefined && how.k === 'op' && how.v === '=') {
      p.i++;
      const from = p.parseExpr();
      if (!p.peekKw('TO')) throw syntax('REPEAT FOR ' + v.v + ' = ... needs TO');
      p.i++;
      const to = p.parseExpr();
      const ctl = listFromArray([v.v, makeBlock(interp, [from]), makeBlock(interp, [to])]);
      return { nodes: [callNode('for', 'REPEAT', [constNode(ctl), constNode(makeBlock(interp, body()))])], next: i + 1 };
    }
    if (p.peekKw('IN')) {
      p.i++;
      const data = p.parseExpr();
      const tpl = new Cell(listFromArray([v.v]), makeBlock(interp, body()));
      return { nodes: [callNode('foreach', 'REPEAT', [data, constNode(tpl)])], next: i + 1 };
    }
    throw syntax('REPEAT FOR ' + v.v + ' needs = or IN');
  }
  const count = p.parseExpr();
  return { nodes: [callNode('repeat', 'REPEAT', [count, constNode(makeBlock(interp, body()))])], next: i + 1 };
}

function compileLine(lines, i, ctx) {
  const line = lines[i];
  const toks = tokensOf(line);
  const first = toks[0];
  if (first.k === 'name') {
    const kw = first.v.toUpperCase();
    if (kw === 'TO') throw err.toInside();
    if (kw === 'THEN' || kw === 'ELSE' || kw === 'UNTIL') throw syntax('unexpected ' + kw);
    if (kw === 'IF') return compileIf(lines, i, ctx);
    if (kw === 'REPEAT') return compileRepeat(lines, i, ctx);
  }
  if (line.children.length) throw syntax('this line is indented under one that does not take a block: ' + line.text);
  const p = new Parser(toks, ctx);
  return { nodes: p.parseStatements(), next: i + 1 };
}

function compileSiblings(lines, ctx) {
  const out = [];
  for (let i = 0; i < lines.length;) {
    const r = compileLine(lines, i, ctx);
    for (const n of r.nodes) out.push(n);
    i = r.next;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// What the interpreter uses

// A cell's top-level statements as nodes, one per statement (each is run on its own, so an error in one does not stop the
// next under onError 'continue').
export function compileTop(interp, lines) {
  const locals = new Set();
  prescan(lines, locals);
  return compileSiblings(lines, { interp, locals });
}

// Reads a cell's source into units (see splitUnits) and hands them out one at a time as Job lines: `{tpn: {kind: 'to',
// line}}` for a definition, `{tpn: {kind: 'node', node}}` for a statement ready to run. Statements are analysed when their
// turn comes, so a procedure defined earlier in the cell is known by then.
export class TpnReader {
  constructor(interp, source) {
    this.interp = interp;
    this.units = splitUnits(buildTree(readLines(source)));
    this.pos = 0;
    this.queue = [];
  }

  readLine() {
    for (;;) {
      if (this.queue.length) return { tpn: { kind: 'node', node: this.queue.shift() } };
      const u = this.units[this.pos++];
      if (u === undefined) return null;
      if (u.kind === 'to') return { tpn: { kind: 'to', line: u.line } };
      this.queue = compileTop(this.interp, u.lines);
    }
  }
}

const rawOf = (line) => [line.raw].concat(...line.children.map(rawOf));
const wordsOf = (line) => [lineWords(line)].concat(...line.children.map(wordsOf));

// A TPN procedure from its title line. The body is analysed later (compileProcBody), when it is first called.
export function buildTpnProc(line) {
  const toks = tokensOf(line);
  const nameTok = toks[1];
  if (nameTok === undefined || nameTok.k !== 'name') throw syntax('TO needs a procedure name');
  const proc = new Proc(nameTok.v);
  proc.dialect = 'tpn';
  const patterns = [];
  for (let i = 2; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === 'punct' && (t.v === '(' || t.v === ')' || t.v === ',')) continue;
    if (t.k === 'name') { proc.required.push({ key: nameKey(t.v), name: t.v }); continue; }
    if (t.k === 'punct' && t.v === '[') {
      const close = matchBracket(toks, i);
      if (close < 0) throw syntax("missing ']'");
      const hidden = '%' + (patterns.length + 1);
      proc.required.push({ key: hidden, name: hidden });
      patterns.push({ arg: hidden, pattern: patternList(toks, i + 1, close) });
      i = close;
      continue;
    }
    throw syntax('unexpected ' + tokenText(t) + ' in the title line');
  }
  proc.min = proc.def = proc.max = proc.required.length;
  proc.tpn = { line, patterns };
  proc.rawLines = rawOf(line);
  proc.lines = line.children.map(wordsOf).flat();
  return proc;
}

// The procedure's body as nodes. Throws a LogoError for a syntax problem.
export function compileProcBody(interp, proc) {
  const { line, patterns } = proc.tpn;
  const locals = new Set(proc.required.map((r) => r.key));
  for (const pt of patterns) patternNames(pt.pattern, locals);
  prescan(line.children, locals);
  const ctx = { interp, locals };
  const title = lineWords(line);
  const nodes = [];
  for (const pt of patterns) {
    const n = callNode('tpn:destructure', '<-', [constNode(pt.pattern), { t: N.VAR, key: pt.arg, name: pt.arg }, constNode('local')]);
    n.line = title;
    nodes.push(n);
  }
  const kids = line.children;
  for (let i = 0; i < kids.length;) {
    const r = compileLine(kids, i, ctx);
    const lw = lineWords(kids[i]);
    for (const n of r.nodes) { n.line = lw; nodes.push(n); }
    i = r.next;
  }
  return nodes;
}

// Installs a TPN procedure. A name that is a Logo primitive or library procedure goes under `tpn:name`, where only TPN code
// sees it. Returns 'defined' or 'redefined'.
export function installTpnProc(interp, proc, opts = {}) {
  const k = nameKey(proc.name);
  const plain = interp.procs.get(k);
  const key = plain !== undefined && (isPrimRecord(plain) || plain.library) ? 'tpn:' + k : k;
  const prior = interp.procs.get(key);
  const userDefined = prior !== undefined && !isPrimRecord(prior) && !prior.library;
  if (userDefined && opts.redefine === false) throw err.alreadyDefined(proc.name);
  proc.key = key;
  if (opts.library) proc.library = true;
  if (opts.owner !== undefined) proc.owner = opts.owner;
  interp.procs.set(key, proc);
  interp.epoch++;
  return userDefined ? 'redefined' : 'defined';
}

// The built-ins whose TPN meaning differs from the Logo primitive of the same name, as `tpn:` records.
export function installPrims(interp) {
  const procs = interp.procs;
  const add = (name, min, def, max, impl) => {
    const key = 'tpn:' + name.toLowerCase();
    procs.set(key, Object.assign({ name, key, min, def, max, special: null }, impl));
  };
  const logoItem = procs.get('item').fn;
  // ITEM(L, N): the list first, the position second (Logo takes them the other way round).
  add('ITEM', 2, 2, 2, { fn: (a, m) => logoItem([a[1], a[0]], m) });
  add('REST', 1, 1, 1, { fn: procs.get('butfirst').fn });
  // The book defines its own ABS and SQRT as examples; Logo has no ABS.
  add('ABS', 1, 1, 1, { fn: (a) => Math.abs(num(a[0], 'abs')) });
  // RAND(LOW, HIGH): a random number from LOW to HIGH; whole numbers in, a whole number out (both ends possible), else a
  // real number in the range.
  add('RAND', 2, 2, 2, {
    fn: (a, m) => {
      const x = num(a[0], 'rand'), y = num(a[1], 'rand');
      const lo = Math.min(x, y), hi = Math.max(x, y);
      if (Number.isInteger(lo) && Number.isInteger(hi)) return lo + Math.floor(m.interp.rng() * (hi - lo + 1));
      return lo + m.interp.rng() * (hi - lo);
    },
  });
  add('BOTH', 2, 2, 2, { op: procs.get('and').op });
  add('EITHER', 2, 2, 2, { op: procs.get('or').op });
  // Assigns the items of a list to the names of a pattern. `how` is 'local' for the inputs of a title line (new bindings in
  // the procedure's scope) and 'set' for an assignment statement (the innermost binding, else a global, as MAKE).
  add('destructure', 3, 3, 3, {
    fn: (a, m) => {
      const local = a[2] === 'local';
      const assign = (pattern, value) => {
        if (!isList(value)) throw err.badType('<-', showForm(value));
        const names = listToArray(pattern), vals = listToArray(value);
        if (vals.length < names.length) throw err.badType('<-', showForm(value));
        names.forEach((nm, k) => {
          if (isList(nm)) { assign(nm, vals[k]); return; }
          const key = nameKey(nm);
          if (local) m.declareLocal(key);
          m.setVar(key, vals[k]);
        });
      };
      assign(a[0], a[1]);
    },
  });
}
