// Plain primitives (they never call back into the interpreter). Higher-order
// library procedures (map, for-each, sort, ...) live in prelude/core.scm, and
// control primitives that need the machine live in control.js.
import {
  Pair, NIL, UNSPEC, DEFAULT, EOF, Sym, Char, SString, Flonum, Ratnum, Closure, Primitive, MPrim,
  Continuation, Parameter, Promise_, Condition, HashTable, Record, Variant, Cell, Values,
  intern, gensym, stripSym, makeChar, arrayToList, listToArray,
} from './types.js';
import * as N from './numeric.js';
import { wrongType, badRange, simpleError } from './errors.js';
import { eq, eqv, equal } from './equality.js';
import { toDisplay, toWrite, conditionReport } from './printer.js';

const isNum = N.isNumber;

export function installPrimitives(interp) {
  const def = (name, min, max, fn) => interp.definePrimitive(new Primitive(name, min, max, fn));
  const alias = (newName, oldName) => interp.aliasPrimitive(newName, oldName);

  // ---------- helpers ----------
  // Once a library turns interp.textNumbers on, text that reads as a number is accepted
  // where a number is required. This only runs where the argument check would otherwise
  // fail, so a call that already works never pays for it and never changes.
  const textNumber = (x) => {
    if (!interp.textNumbers || !(x instanceof SString)) return undefined;
    const r = N.parseNumber(x.s);
    return r === null ? undefined : r;
  };
  const num = (x, i, who) => {
    if (isNum(x)) return x;
    const t = textNumber(x);
    if (t !== undefined) return t;
    throw wrongType(x, i, who);
  };
  const int = (x, i, who) => {
    if (N.isInteger(x)) return x;
    const t = textNumber(x);
    if (t !== undefined && N.isInteger(t)) return t;
    throw wrongType(x, i, who);
  };
  const idx = (x, i, who) => {
    if (typeof x !== 'number') { const t = textNumber(x); if (t !== undefined) x = t; }
    if (typeof x !== 'number' || x < 0) { if (!N.isExactInt(x)) throw wrongType(x, i, who); throw badRange(x, i, who); }
    return x;
  };
  const str = (x, i, who) => { if (!(x instanceof SString)) throw wrongType(x, i, who); return x.s; };
  const sym = (x, i, who) => { if (!(x instanceof Sym)) throw wrongType(x, i, who); return x; };
  const chr = (x, i, who) => { if (!(x instanceof Char)) throw wrongType(x, i, who); return x; };
  const pair = (x, i, who) => { if (!(x instanceof Pair)) throw wrongType(x, i, who); return x; };
  const lst = (x, i, who) => { const a = listToArray(x); if (a === null) throw wrongType(x, i, who); return a; };
  const vec = (x, i, who) => { if (!Array.isArray(x)) throw wrongType(x, i, who); return x; };
  const mkstr = (s) => new SString(s);

  // ---------- numbers ----------
  const plus = function (a, b) {
    const n = arguments.length;
    if (n === 2) {
      if (typeof a === 'number' && typeof b === 'number') { const r = a + b; if (Number.isSafeInteger(r)) return r; }
      return N.add(num(a, 1, 'integer-add'), num(b, 2, 'integer-add'));
    }
    let r = 0;
    for (let i = 0; i < n; i++) r = N.add(r, num(arguments[i], i + 1, 'integer-add'));
    return r;
  };
  def('+', 0, -1, plus);
  def('*', 0, -1, function (a, b) {
    const n = arguments.length;
    if (n === 2) return N.mul(num(a, 1, 'integer-multiply'), num(b, 2, 'integer-multiply'));
    let r = 1;
    for (let i = 0; i < n; i++) r = N.mul(r, num(arguments[i], i + 1, 'integer-multiply'));
    return r;
  });
  def('-', 1, -1, function (a, b) {
    const n = arguments.length;
    if (n === 2) {
      if (typeof a === 'number' && typeof b === 'number') { const r = a - b; if (Number.isSafeInteger(r)) return r; }
      return N.sub(num(a, 1, 'integer-subtract'), num(b, 2, 'integer-subtract'));
    }
    if (n === 1) return N.negate(num(a, 1, 'integer-negate'));
    let r = num(a, 1, 'integer-subtract');
    for (let i = 1; i < n; i++) r = N.sub(r, num(arguments[i], i + 1, 'integer-subtract'));
    return r;
  });
  def('/', 1, -1, function (a, b) {
    const n = arguments.length;
    if (n === 1) return N.div(1, num(a, 1, '/'));
    let r = num(a, 1, '/');
    for (let i = 1; i < n; i++) r = N.div(r, num(arguments[i], i + 1, '/'));
    return r;
  });
  const chain = (name, who, test) => def(name, 1, -1, function (a, b) {
    const n = arguments.length;
    if (n === 2) {
      if (typeof a === 'number' && typeof b === 'number') return test(a < b ? -1 : a > b ? 1 : 0);
      return test(N.cmp(num(a, 1, who), num(b, 2, who)));
    }
    const v = [];
    for (let i = 0; i < n; i++) v.push(num(arguments[i], i + 1, who));
    for (let i = 0; i + 1 < n; i++) if (!test(N.cmp(v[i], v[i + 1]))) return false;
    return true;
  });
  chain('=', 'integer-equal?', (c) => c === 0);
  chain('<', 'integer-less?', (c) => c < 0);
  chain('>', 'integer-less?', (c) => c > 0);
  chain('<=', 'integer-less-or-equal?', (c) => c <= 0);
  chain('>=', 'integer-less-or-equal?', (c) => c >= 0);

  def('number?', 1, 1, isNum); alias('complex?', 'number?'); alias('real?', 'number?');
  def('rational?', 1, 1, (x) => isNum(x) && N.isRational(x));
  def('integer?', 1, 1, N.isInteger);
  def('exact?', 1, 1, (x) => N.isExact(num(x, 1, 'exact?')));
  def('inexact?', 1, 1, (x) => !N.isExact(num(x, 1, 'inexact?')));
  def('exact-integer?', 1, 1, N.isExactInt);
  def('exact-rational?', 1, 1, N.isExact);
  def('exact-nonnegative-integer?', 1, 1, (x) => N.isExactInt(x) && N.sign(x) >= 0);
  def('nan?', 1, 1, (x) => x instanceof Flonum && Number.isNaN(x.v));
  def('finite?', 1, 1, (x) => !(x instanceof Flonum) || Number.isFinite(x.v));
  def('infinite?', 1, 1, (x) => x instanceof Flonum && (x.v === Infinity || x.v === -Infinity));
  def('zero?', 1, 1, (x) => N.isZero(num(x, 1, 'zero?')));
  def('positive?', 1, 1, (x) => N.sign(num(x, 1, 'positive?')) > 0);
  def('negative?', 1, 1, (x) => N.sign(num(x, 1, 'negative?')) < 0);
  def('odd?', 1, 1, (x) => N.parity(int(x, 1, 'integer-remainder')) === 1);
  def('even?', 1, 1, (x) => N.parity(int(x, 1, 'integer-remainder')) === 0);
  def('1+', 1, 1, (x) => N.add(num(x, 1, 'integer-add'), 1));
  def('-1+', 1, 1, (x) => N.sub(num(x, 1, 'integer-subtract'), 1));
  alias('1-', '-1+');
  def('add1', 1, 1, (x) => N.add(num(x, 1, 'integer-add'), 1));
  def('sub1', 1, 1, (x) => N.sub(num(x, 1, 'integer-subtract'), 1));
  def('abs', 1, 1, (x) => N.abs(num(x, 1, 'integer-abs'))); alias('magnitude', 'abs');
  def('square', 1, 1, (x) => { x = num(x, 1, 'integer-multiply'); return N.mul(x, x); });
  def('cube', 1, 1, (x) => { x = num(x, 1, 'integer-multiply'); return N.mul(x, N.mul(x, x)); });
  def('quotient', 2, 2, (a, b) => N.quotient(int(a, 1, 'integer-quotient'), int(b, 2, 'integer-quotient')));
  def('remainder', 2, 2, (a, b) => N.remainder(int(a, 1, 'integer-remainder'), int(b, 2, 'integer-remainder')));
  def('modulo', 2, 2, (a, b) => N.modulo(int(a, 1, 'integer-modulo'), int(b, 2, 'integer-modulo')));
  alias('truncate-quotient', 'quotient'); alias('truncate-remainder', 'remainder');
  alias('floor-remainder', 'modulo');
  def('floor-quotient', 2, 2, (a, b) => N.floor(N.div(int(a, 1, 'floor-quotient'), int(b, 2, 'floor-quotient'))));
  def('gcd', 0, -1, (...a) => a.reduce((acc, x, i) => N.gcd(acc, int(x, i + 1, 'gcd')), 0));
  def('lcm', 0, -1, (...a) => a.reduce((acc, x, i) => N.lcm(acc, int(x, i + 1, 'lcm')), 1));
  def('numerator', 1, 1, (x) => (x instanceof Ratnum ? N.normBig(x.n) : x instanceof Flonum ? N.toInexact(N.toExact(x) instanceof Ratnum ? N.normBig(N.toExact(x).n) : N.toExact(x)) : num(x, 1, 'numerator')));
  def('denominator', 1, 1, (x) => (x instanceof Ratnum ? N.normBig(x.d) : x instanceof Flonum ? N.toInexact(N.toExact(x) instanceof Ratnum ? N.normBig(N.toExact(x).d) : 1) : (num(x, 1, 'denominator'), 1)));
  def('floor', 1, 1, (x) => N.floor(num(x, 1, 'floor')));
  def('ceiling', 1, 1, (x) => N.ceiling(num(x, 1, 'ceiling')));
  def('round', 1, 1, (x) => N.round(num(x, 1, 'round')));
  def('truncate', 1, 1, (x) => N.truncate(num(x, 1, 'truncate')));
  def('floor->exact', 1, 1, (x) => N.toExact(N.floor(num(x, 1, 'floor->exact'))));
  def('ceiling->exact', 1, 1, (x) => N.toExact(N.ceiling(num(x, 1, 'ceiling->exact'))));
  def('round->exact', 1, 1, (x) => N.toExact(N.round(num(x, 1, 'round->exact'))));
  def('truncate->exact', 1, 1, (x) => N.toExact(N.truncate(num(x, 1, 'truncate->exact'))));
  def('exact', 1, 1, (x) => N.toExact(num(x, 1, 'inexact->exact'))); alias('inexact->exact', 'exact');
  def('inexact', 1, 1, (x) => N.toInexact(num(x, 1, 'exact->inexact'))); alias('exact->inexact', 'inexact');
  def('max', 1, -1, (...a) => minmax(a, 'max', 1));
  def('min', 1, -1, (...a) => minmax(a, 'min', -1));
  function minmax(a, who, dir) {
    let r = num(a[0], 1, who), inexact = r instanceof Flonum;
    for (let i = 1; i < a.length; i++) {
      const x = num(a[i], i + 1, who);
      if (x instanceof Flonum) inexact = true;
      if (N.cmp(x, r) * dir > 0) r = x;
    }
    return inexact ? N.toInexact(r) : r;
  }
  const fl = (name, f, exactCase) => def(name, 1, 1, (x) => {
    x = num(x, 1, name);
    if (exactCase && x === exactCase[0]) return exactCase[1];
    return new Flonum(f(N.toFloat(x)));
  });
  fl('exp', Math.exp, [0, 1]); fl('sin', Math.sin, [0, 0]); fl('cos', Math.cos, [0, 1]); fl('tan', Math.tan, [0, 0]);
  fl('asin', Math.asin, [0, 0]); fl('acos', Math.acos, [1, 0]);
  def('log', 1, 2, (x, b) => {
    x = num(x, 1, 'log');
    if (b === undefined) return x === 1 ? 0 : new Flonum(Math.log(N.toFloat(x)));
    return new Flonum(Math.log(N.toFloat(x)) / Math.log(N.toFloat(num(b, 2, 'log'))));
  });
  def('atan', 1, 2, (y, x) => {
    y = num(y, 1, 'atan');
    if (x === undefined) return y === 0 ? 0 : new Flonum(Math.atan(N.toFloat(y)));
    x = num(x, 2, 'atan');
    if (y === 0 && N.isExact(x) && N.sign(x) > 0) return 0;
    return new Flonum(Math.atan2(N.toFloat(y), N.toFloat(x)));
  });
  def('sqrt', 1, 1, (x) => N.sqrt(num(x, 1, 'sqrt')));
  def('exact-integer-sqrt', 1, 1, (x) => { const [s, r] = N.exactIntegerSqrt(x); return new Values([s, r]); });
  def('expt', 2, 2, (a, b) => N.expt(num(a, 1, 'expt'), num(b, 2, 'expt')));
  def('number->string', 1, 2, (x, radix) => mkstr(N.numberToString(num(x, 1, 'number->string'), radix === undefined ? 10 : radix)));
  def('string->number', 1, 2, (s, radix) => { const r = N.parseNumber(str(s, 1, 'string->number'), radix === undefined ? 10 : radix); return r === null ? false : r; });
  def('random', 1, 2, (n) => {
    n = num(n, 1, 'random');
    if (N.sign(n) <= 0) throw badRange(n, 1, 'random');
    return N.randomBelow(n);
  });
  def('bitwise-and', 0, -1, (...a) => a.reduce((x, y) => N.normBig(BigInt(x) & BigInt(y)), -1));
  def('bitwise-or', 0, -1, (...a) => a.reduce((x, y) => N.normBig(BigInt(x) | BigInt(y)), 0));
  def('bitwise-xor', 0, -1, (...a) => a.reduce((x, y) => N.normBig(BigInt(x) ^ BigInt(y)), 0));
  def('arithmetic-shift', 2, 2, (x, s) => N.normBig(s >= 0 ? BigInt(x) << BigInt(s) : BigInt(x) >> BigInt(-s)));

  // ---------- booleans / equivalence / types ----------
  def('not', 1, 1, (x) => x === false);
  def('eq?', 2, 2, eq); def('eqv?', 2, 2, eqv); def('equal?', 2, 2, equal);
  def('boolean?', 1, 1, (x) => x === true || x === false);
  def('boolean=?', 2, -1, (...a) => a.every((x) => x === a[0]));
  def('symbol?', 1, 1, (x) => x instanceof Sym);
  def('string?', 1, 1, (x) => x instanceof SString);
  def('char?', 1, 1, (x) => x instanceof Char);
  def('vector?', 1, 1, Array.isArray);
  def('pair?', 1, 1, (x) => x instanceof Pair);
  def('null?', 1, 1, (x) => x === NIL);
  def('procedure?', 1, 1, (x) => x instanceof Closure || x instanceof Primitive || x instanceof MPrim || x instanceof Continuation || x instanceof Parameter);
  def('default-object?', 1, 1, (x) => x === DEFAULT);
  def('eof-object', 0, 0, () => EOF);
  def('eof-object?', 1, 1, (x) => x === EOF);

  // ---------- pairs and lists ----------
  def('cons', 2, 2, (a, b) => new Pair(a, b));
  def('car', 1, 1, (p) => { if (p instanceof Pair) return p.car; throw wrongType(p, 1, 'car'); });
  def('cdr', 1, 1, (p) => { if (p instanceof Pair) return p.cdr; throw wrongType(p, 1, 'cdr'); });
  def('set-car!', 2, 2, (p, v) => { pair(p, 1, 'set-car!').car = v; return UNSPEC; });
  def('set-cdr!', 2, 2, (p, v) => { pair(p, 1, 'set-cdr!').cdr = v; return UNSPEC; });
  // c[ad]{2,4}r
  const combos = [];
  for (let len = 2; len <= 4; len++) {
    const rec = (prefix) => { if (prefix.length === len) { combos.push(prefix); return; } rec(prefix + 'a'); rec(prefix + 'd'); };
    rec('');
  }
  for (const c of combos) {
    const name = 'c' + c + 'r';
    def(name, 1, 1, (p) => {
      let x = p;
      for (let i = c.length - 1; i >= 0; i--) {
        if (!(x instanceof Pair)) throw wrongType(p, 1, name);
        x = c[i] === 'a' ? x.car : x.cdr;
      }
      return x;
    });
  }
  def('list', 0, -1, (...a) => arrayToList(a));
  def('cons*', 1, -1, (...a) => arrayToList(a.slice(0, -1), a[a.length - 1])); alias('list*', 'cons*');
  def('make-list', 1, 2, (n, fill) => arrayToList(new Array(idx(n, 1, 'make-list')).fill(fill === undefined ? UNSPEC : fill)));
  def('list?', 1, 1, (x) => listToArray(x) !== null);
  def('length', 1, 1, (l) => {
    let n = 0, x = l;
    while (x instanceof Pair) { n++; x = x.cdr; if (n > 50_000_000) throw wrongType(l, 1, 'length'); }
    if (x !== NIL) throw wrongType(l, 1, 'length');
    return n;
  });
  def('append', 0, -1, (...a) => {
    if (a.length === 0) return NIL;
    let result = a[a.length - 1];
    for (let i = a.length - 2; i >= 0; i--) result = arrayToList(lst(a[i], i + 1, 'append'), result);
    return result;
  });
  alias('append!', 'append');
  def('reverse', 1, 1, (l) => {
    let r = NIL, x = l;
    while (x instanceof Pair) { r = new Pair(x.car, r); x = x.cdr; }
    if (x !== NIL) throw wrongType(l, 1, 'reverse');
    return r;
  });
  alias('reverse!', 'reverse');
  def('list-tail', 2, 2, (l, k) => {
    let x = l;
    for (let i = idx(k, 2, 'list-tail'); i > 0; i--) { if (!(x instanceof Pair)) throw badRange(k, 2, 'list-tail'); x = x.cdr; }
    return x;
  });
  def('list-head', 2, 2, (l, k) => {
    const out = [];
    let x = l;
    for (let i = idx(k, 2, 'list-head'); i > 0; i--) { if (!(x instanceof Pair)) throw badRange(k, 2, 'list-head'); out.push(x.car); x = x.cdr; }
    return arrayToList(out);
  });
  def('list-ref', 2, 2, (l, k) => {
    let x = l;
    for (let i = idx(k, 2, 'list-ref'); i > 0; i--) { if (!(x instanceof Pair)) throw badRange(k, 2, 'list-ref'); x = x.cdr; }
    if (!(x instanceof Pair)) throw badRange(k, 2, 'list-ref');
    return x.car;
  });
  def('list-copy', 1, 1, (l) => { const a = []; let x = l; while (x instanceof Pair) { a.push(x.car); x = x.cdr; } return arrayToList(a, x); });
  def('last-pair', 1, 1, (l) => { let x = pair(l, 1, 'last-pair'); while (x.cdr instanceof Pair) x = x.cdr; return x; });
  def('last', 1, 1, (l) => { let x = pair(l, 1, 'last'); while (x.cdr instanceof Pair) x = x.cdr; return x.car; });
  def('except-last-pair!', 1, 1, (l) => arrayToList(lst(l, 1, 'except-last-pair!').slice(0, -1)));
  alias('except-last-pair', 'except-last-pair!');
  def('sublist', 3, 3, (l, s, e) => arrayToList(lst(l, 1, 'sublist').slice(idx(s, 2, 'sublist'), idx(e, 3, 'sublist'))));
  ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'].forEach((name, n) => {
    def(name, 1, 1, (l) => {
      let x = l;
      for (let i = 0; i < n; i++) { if (!(x instanceof Pair)) throw wrongType(l, 1, name); x = x.cdr; }
      if (!(x instanceof Pair)) throw wrongType(l, 1, name);
      return x.car;
    });
  });
  def('iota', 1, 3, (n, start, step) => {
    const out = [];
    let v = start === undefined ? 0 : start;
    const st = step === undefined ? 1 : step;
    for (let i = idx(n, 1, 'iota'); i > 0; i--) { out.push(v); v = N.add(v, st); }
    return arrayToList(out);
  });
  const mem = (name, test) => def(name, 2, 2, (x, l) => {
    let p = l;
    while (p instanceof Pair) { if (test(x, p.car)) return p; p = p.cdr; }
    return false;
  });
  mem('memq', eq); mem('memv', eqv); mem('%member', equal);
  const ass = (name, test) => def(name, 2, 2, (x, l) => {
    let p = l;
    while (p instanceof Pair) {
      const e = p.car;
      if (!(e instanceof Pair)) throw wrongType(e, 1, 'car');
      if (test(x, e.car)) return e;
      p = p.cdr;
    }
    return false;
  });
  ass('assq', eq); ass('assv', eqv); ass('%assoc', equal);
  const del = (name, test) => def(name, 2, 3, (x, l) => {
    const out = [];
    let p = l;
    while (p instanceof Pair) { if (!test(x, p.car)) out.push(p.car); p = p.cdr; }
    return arrayToList(out);
  });
  del('delete', equal); alias('delete!', 'delete'); del('delq', eq); alias('delq!', 'delq'); del('delv', eqv);
  def('list-index-of', 2, 2, (x, l) => { let i = 0, p = l; while (p instanceof Pair) { if (equal(x, p.car)) return i; i++; p = p.cdr; } return false; });

  // ---------- symbols ----------
  def('symbol->string', 1, 1, (s) => mkstr(stripSym(sym(s, 1, 'symbol->string')).name));
  def('string->symbol', 1, 1, (s) => intern(str(s, 1, 'string->symbol')));
  alias('intern', 'string->symbol');
  def('string->uninterned-symbol', 1, 1, (s) => new Sym(str(s, 1, 'string->uninterned-symbol')));
  def('symbol-append', 0, -1, (...a) => intern(a.map((s, i) => stripSym(sym(s, i + 1, 'symbol-append')).name).join('')));
  def('generate-uninterned-symbol', 0, 1, () => gensym('g')); alias('gensym', 'generate-uninterned-symbol');
  def('symbol<?', 2, -1, (...a) => { for (let i = 0; i + 1 < a.length; i++) if (!(stripSym(sym(a[i], i + 1, 'symbol<?')).name < stripSym(sym(a[i + 1], i + 2, 'symbol<?')).name)) return false; return true; });

  // ---------- characters ----------
  def('char->integer', 1, 1, (c) => chr(c, 1, 'char->integer').cp);
  def('integer->char', 1, 1, (n) => makeChar(idx(n, 1, 'integer->char')));
  const charCmp = (name, test, fold) => def(name, 1, -1, (...a) => {
    const cps = a.map((c, i) => { const cp = chr(c, i + 1, name).cp; return fold ? String.fromCodePoint(cp).toLowerCase().codePointAt(0) : cp; });
    for (let i = 0; i + 1 < cps.length; i++) if (!test(cps[i], cps[i + 1])) return false;
    return true;
  });
  charCmp('char=?', (a, b) => a === b); charCmp('char<?', (a, b) => a < b); charCmp('char>?', (a, b) => a > b);
  charCmp('char<=?', (a, b) => a <= b); charCmp('char>=?', (a, b) => a >= b);
  charCmp('char-ci=?', (a, b) => a === b, true);
  const cstr = (c, who) => String.fromCodePoint(chr(c, 1, who).cp);
  def('char-alphabetic?', 1, 1, (c) => /\p{L}/u.test(cstr(c, 'char-alphabetic?')));
  def('char-numeric?', 1, 1, (c) => /\p{Nd}/u.test(cstr(c, 'char-numeric?')));
  def('char-whitespace?', 1, 1, (c) => /\s/u.test(cstr(c, 'char-whitespace?')));
  def('char-upper-case?', 1, 1, (c) => /\p{Lu}/u.test(cstr(c, 'char-upper-case?')));
  def('char-lower-case?', 1, 1, (c) => /\p{Ll}/u.test(cstr(c, 'char-lower-case?')));
  def('char-upcase', 1, 1, (c) => makeChar(cstr(c, 'char-upcase').toUpperCase().codePointAt(0)));
  def('char-downcase', 1, 1, (c) => makeChar(cstr(c, 'char-downcase').toLowerCase().codePointAt(0)));
  def('char->digit', 1, 2, (c, radix) => { const d = parseInt(cstr(c, 'char->digit'), radix === undefined ? 10 : radix); return Number.isNaN(d) ? false : d; });
  def('digit->char', 1, 2, (d, radix) => makeChar(d.toString(radix === undefined ? 10 : radix).codePointAt(0)));
  def('digit-value', 1, 1, (c) => { const d = parseInt(cstr(c, 'digit-value'), 10); return Number.isNaN(d) ? false : d; });

  // ---------- strings ----------
  def('make-string', 1, 2, (n, c) => mkstr((c === undefined ? ' ' : String.fromCodePoint(chr(c, 2, 'make-string').cp)).repeat(idx(n, 1, 'make-string'))));
  def('string', 0, -1, (...a) => mkstr(a.map((x) => (x instanceof Char ? String.fromCodePoint(x.cp) : toDisplay(x))).join('')));
  def('string-length', 1, 1, (s) => [...str(s, 1, 'string-length')].length);
  def('string-ref', 2, 2, (s, k) => {
    const cs = [...str(s, 1, 'string-ref')];
    if (typeof k !== 'number') throw wrongType(k, 2, 'string-ref');
    if (k < 0 || k >= cs.length) throw badRange(k, 2, 'string-ref');
    return makeChar(cs[k].codePointAt(0));
  });
  def('string-set!', 3, 3, (s, k, c) => {
    const cs = [...str(s, 1, 'string-set!')];
    if (typeof k !== 'number') throw wrongType(k, 2, 'string-set!');
    if (k < 0 || k >= cs.length) throw badRange(k, 2, 'string-set!');
    cs[k] = String.fromCodePoint(chr(c, 3, 'string-set!').cp);
    s.s = cs.join('');
    return UNSPEC;
  });
  def('substring', 2, 3, (s, start, end) => {
    const cs = [...str(s, 1, 'substring')];
    const e = end === undefined ? cs.length : idx(end, 3, 'substring');
    const b = idx(start, 2, 'substring');
    if (e > cs.length) throw badRange(end, 3, 'substring');
    if (b > e) throw badRange(start, 2, 'substring');
    return mkstr(cs.slice(b, e).join(''));
  });
  def('string-head', 2, 2, (s, e) => { const cs = [...str(s, 1, 'string-head')]; if (idx(e, 2, 'string-head') > cs.length) throw badRange(e, 2, 'string-head'); return mkstr(cs.slice(0, e).join('')); });
  def('string-tail', 2, 2, (s, b) => { const cs = [...str(s, 1, 'string-tail')]; if (idx(b, 2, 'string-tail') > cs.length) throw badRange(b, 2, 'string-tail'); return mkstr(cs.slice(b).join('')); });
  def('string-append', 0, -1, (...a) => mkstr(a.map((s, i) => str(s, i + 1, 'string-append')).join('')));
  def('string-copy', 1, 3, (s, b, e) => { const cs = [...str(s, 1, 'string-copy')]; return mkstr(cs.slice(b === undefined ? 0 : b, e === undefined ? cs.length : e).join('')); });
  def('string-null?', 1, 1, (s) => str(s, 1, 'string-null?') === '');
  def('string-upcase', 1, 1, (s) => mkstr(str(s, 1, 'string-upcase').toUpperCase()));
  def('string-downcase', 1, 1, (s) => mkstr(str(s, 1, 'string-downcase').toLowerCase()));
  def('string-reverse', 1, 1, (s) => mkstr([...str(s, 1, 'string-reverse')].reverse().join('')));
  def('string->list', 1, 3, (s, b, e) => { const cs = [...str(s, 1, 'string->list')].slice(b === undefined ? 0 : b, e === undefined ? undefined : e); return arrayToList(cs.map((c) => makeChar(c.codePointAt(0)))); });
  def('list->string', 1, 1, (l) => mkstr(lst(l, 1, 'list->string').map((c) => String.fromCodePoint(chr(c, 1, 'list->string').cp)).join('')));
  def('string->vector', 1, 1, (s) => [...str(s, 1, 'string->vector')].map((c) => makeChar(c.codePointAt(0))));
  def('vector->string', 1, 1, (v) => mkstr(vec(v, 1, 'vector->string').map((c) => String.fromCodePoint(c.cp)).join('')));
  def('string-fill!', 2, 2, (s, c) => { s.s = String.fromCodePoint(chr(c, 2, 'string-fill!').cp).repeat([...s.s].length); return UNSPEC; });
  def('string-index', 2, 2, (s, c) => { const i = [...str(s, 1, 'string-index')].findIndex((x) => x.codePointAt(0) === chr(c, 2, 'string-index').cp); return i < 0 ? false : i; });
  def('string-search-forward', 3, 3, (pat, s, start) => { const i = str(s, 2, 'string-search-forward').indexOf(str(pat, 1, 'string-search-forward'), start); return i < 0 ? false : i; });
  def('string-search-all', 2, 3, (pat, s) => { const out = []; const p = str(pat, 1, 'string-search-all'), t = str(s, 2, 'string-search-all'); for (let i = t.indexOf(p); i >= 0; i = t.indexOf(p, i + 1)) out.push(i); return arrayToList(out); });
  def('string-pad-left', 2, 3, (s, n, c) => {
    const cs = [...str(s, 1, 'string-pad-left')], k = idx(n, 2, 'string-pad-left'), ch = c === undefined ? ' ' : String.fromCodePoint(c.cp);
    return mkstr(cs.length >= k ? cs.slice(cs.length - k).join('') : ch.repeat(k - cs.length) + cs.join(''));
  });
  def('string-pad-right', 2, 3, (s, n, c) => {
    const cs = [...str(s, 1, 'string-pad-right')], k = idx(n, 2, 'string-pad-right'), ch = c === undefined ? ' ' : String.fromCodePoint(c.cp);
    return mkstr(cs.length >= k ? cs.slice(0, k).join('') : cs.join('') + ch.repeat(k - cs.length));
  });
  def('string-trim', 1, 1, (s) => mkstr(str(s, 1, 'string-trim').trim()));
  def('string-trim-left', 1, 1, (s) => mkstr(str(s, 1, 'string-trim-left').trimStart()));
  def('string-trim-right', 1, 1, (s) => mkstr(str(s, 1, 'string-trim-right').trimEnd()));
  def('string-join', 1, 2, (l, d) => mkstr(lst(l, 1, 'string-join').map((s) => str(s, 1, 'string-join')).join(d === undefined ? ' ' : str(d, 2, 'string-join'))));
  const strCmp = (name, test, fold) => def(name, 1, -1, (...a) => {
    const ss = a.map((s, i) => { const v = str(s, i + 1, name); return fold ? v.toLowerCase() : v; });
    for (let i = 0; i + 1 < ss.length; i++) if (!test(ss[i], ss[i + 1])) return false;
    return true;
  });
  strCmp('string=?', (a, b) => a === b); strCmp('string<?', (a, b) => a < b); strCmp('string>?', (a, b) => a > b);
  strCmp('string<=?', (a, b) => a <= b); strCmp('string>=?', (a, b) => a >= b);
  strCmp('string-ci=?', (a, b) => a === b, true); strCmp('string-ci<?', (a, b) => a < b, true);

  // ---------- vectors ----------
  def('make-vector', 1, 2, (n, fill) => new Array(idx(n, 1, 'make-vector')).fill(fill === undefined ? false : fill));
  def('vector', 0, -1, (...a) => a);
  def('vector-length', 1, 1, (v) => vec(v, 1, 'vector-length').length);
  def('vector-ref', 2, 2, (v, k) => {
    if (!Array.isArray(v)) throw wrongType(v, 1, 'vector-ref');
    if (typeof k !== 'number') { const t = textNumber(k); if (typeof t !== 'number') throw wrongType(k, 2, 'vector-ref'); k = t; }
    if (k < 0 || k >= v.length) throw badRange(k, 2, 'vector-ref');
    return v[k];
  });
  def('vector-set!', 3, 3, (v, k, x) => {
    if (!Array.isArray(v)) throw wrongType(v, 1, 'vector-set!');
    if (typeof k !== 'number') { const t = textNumber(k); if (typeof t !== 'number') throw wrongType(k, 2, 'vector-set!'); k = t; }
    if (k < 0 || k >= v.length) throw badRange(k, 2, 'vector-set!');
    v[k] = x;
    return UNSPEC;
  });
  def('vector->list', 1, 3, (v, b, e) => arrayToList(vec(v, 1, 'vector->list').slice(b === undefined ? 0 : b, e === undefined ? undefined : e)));
  def('list->vector', 1, 1, (l) => lst(l, 1, 'list->vector').slice());
  def('vector-fill!', 2, 2, (v, x) => { vec(v, 1, 'vector-fill!').fill(x); return UNSPEC; });
  def('vector-grow', 2, 2, (v, n) => { const r = vec(v, 1, 'vector-grow').slice(); while (r.length < n) r.push(false); return r; });
  def('vector-copy', 1, 3, (v, b, e) => vec(v, 1, 'vector-copy').slice(b === undefined ? 0 : b, e === undefined ? undefined : e));
  alias('subvector', 'vector-copy');
  def('vector-append', 0, -1, (...a) => [].concat(...a.map((v, i) => vec(v, i + 1, 'vector-append'))));
  def('vector-copy!', 3, 5, (to, at, from, b, e) => {
    const src = vec(from, 3, 'vector-copy!').slice(b === undefined ? 0 : b, e === undefined ? undefined : e);
    vec(to, 1, 'vector-copy!');
    if (at + src.length > to.length) throw badRange(at, 2, 'vector-copy!');
    for (let i = 0; i < src.length; i++) to[at + i] = src[i];
    return UNSPEC;
  });

  // ---------- hash tables ----------
  const hkey = (kind, k) => {
    if (typeof k === 'number' || typeof k === 'boolean') return k;
    if (typeof k === 'bigint') return 'b' + k;
    if (k instanceof Flonum) return 'f' + k.v;
    if (k instanceof Ratnum) return 'r' + k.n + '/' + k.d;
    if (k instanceof Char) return 'c' + k.cp;
    if (kind === 'equal' || kind === 'string') {
      if (k instanceof SString) return 's' + k.s;
      if (k instanceof Pair || Array.isArray(k) || k instanceof Record || k instanceof Variant) return 'p' + toWrite(k);
    }
    return k;
  };
  const table = (x, i, who) => { if (!(x instanceof HashTable)) throw wrongType(x, i, who); return x; };
  for (const [name, kind] of [['make-equal-hash-table', 'equal'], ['make-strong-eqv-hash-table', 'eqv'], ['make-strong-eq-hash-table', 'eq'],
    ['make-key-weak-eqv-hash-table', 'eqv'], ['make-key-weak-eq-hash-table', 'eq'], ['make-eqv-hash-table', 'eqv'], ['make-eq-hash-table', 'eq'],
    ['make-string-hash-table', 'string'], ['make-hash-table', 'equal']]) {
    def(name, 0, -1, () => new HashTable(kind));
  }
  def('hash-table?', 1, 1, (x) => x instanceof HashTable);
  def('hash-table-set!', 3, 3, (t, k, v) => { table(t, 1, 'hash-table-set!').map.set(hkey(t.kind, k), [k, v]); return UNSPEC; });
  alias('hash-table/put!', 'hash-table-set!');
  const NOT_FOUND = new Cell(null);
  def('%hash-table-ref', 2, 2, (t, k) => { const e = table(t, 1, 'hash-table-ref').map.get(hkey(t.kind, k)); return e ? e[1] : NOT_FOUND; });
  def('%hash-table-not-found?', 1, 1, (x) => x === NOT_FOUND);
  def('hash-table-ref/default', 3, 3, (t, k, d) => { const e = table(t, 1, 'hash-table-ref/default').map.get(hkey(t.kind, k)); return e ? e[1] : d; });
  alias('hash-table/get', 'hash-table-ref/default');
  def('hash-table-delete!', 2, 2, (t, k) => { table(t, 1, 'hash-table-delete!').map.delete(hkey(t.kind, k)); return UNSPEC; });
  alias('hash-table/remove!', 'hash-table-delete!');
  def('hash-table-contains?', 2, 2, (t, k) => table(t, 1, 'hash-table-contains?').map.has(hkey(t.kind, k)));
  alias('hash-table-exists?', 'hash-table-contains?');
  def('hash-table-count', 1, 1, (t) => table(t, 1, 'hash-table-count').map.size);
  alias('hash-table-size', 'hash-table-count'); alias('hash-table/count', 'hash-table-count');
  def('hash-table-keys', 1, 1, (t) => arrayToList([...table(t, 1, 'hash-table-keys').map.values()].map((e) => e[0])));
  alias('hash-table/key-list', 'hash-table-keys');
  def('hash-table-values', 1, 1, (t) => arrayToList([...table(t, 1, 'hash-table-values').map.values()].map((e) => e[1])));
  alias('hash-table/datum-list', 'hash-table-values');
  def('hash-table->alist', 1, 1, (t) => arrayToList([...table(t, 1, 'hash-table->alist').map.values()].map((e) => new Pair(e[0], e[1]))));
  def('hash-table-clear!', 1, 1, (t) => { table(t, 1, 'hash-table-clear!').map.clear(); return UNSPEC; });
  alias('hash-table/clear!', 'hash-table-clear!');
  def('hash-table-copy', 1, 2, (t) => { const c = new HashTable(table(t, 1, 'hash-table-copy').kind); for (const [k, e] of t.map) c.map.set(k, [e[0], e[1]]); return c; });

  // association lists
  def('del-assq', 2, 2, (k, al) => arrayToList(lst(al, 2, 'del-assq').filter((e) => !(e instanceof Pair && eq(e.car, k)))));
  alias('del-assv', 'del-assq');
  def('del-assoc', 2, 2, (k, al) => arrayToList(lst(al, 2, 'del-assoc').filter((e) => !(e instanceof Pair && equal(e.car, k)))));
  def('alist-copy', 1, 1, (al) => arrayToList(lst(al, 1, 'alist-copy').map((e) => (e instanceof Pair ? new Pair(e.car, e.cdr) : e))));

  // ---------- conditions / errors ----------
  def('error', 0, -1, (msg, ...irritants) => { throw simpleError(msg === undefined ? mkstr('') : msg, irritants); });
  def('warn', 0, -1, () => UNSPEC);
  def('assert', 1, -1, (ok) => { if (ok === false) throw simpleError(mkstr('Assertion failed'), []); return UNSPEC; });
  def('error?', 1, 1, (x) => x instanceof Condition);
  def('condition?', 1, 1, (x) => x instanceof Condition);
  def('error-object?', 1, 1, (x) => x instanceof Condition);
  def('error-message', 1, 1, (c) => condMessage(c, 'error-message'));
  alias('error-object-message', 'error-message'); alias('error-message-string', 'error-message');
  def('error-irritants', 1, 1, (c) => { if (!(c instanceof Condition)) throw wrongType(c, 1, 'error-irritants'); return arrayToList(c.irritants); });
  alias('error-object-irritants', 'error-irritants');
  function condMessage(c, who) {
    if (!(c instanceof Condition)) throw wrongType(c, 1, who);
    if (c.kind === 'simple-error') return typeof c.message === 'string' ? mkstr(c.message) : c.message;
    return mkstr(conditionReport(c));
  }
  def('condition/report-string', 1, 1, (c) => { if (!(c instanceof Condition)) throw wrongType(c, 1, 'condition/report-string'); return mkstr(conditionReport(c)); });
  def('access-condition', 2, 2, (c, field) => {
    if (!(c instanceof Condition)) throw wrongType(c, 1, 'access-condition');
    const f = stripSym(sym(field, 2, 'access-condition')).name;
    if (f === 'message') return condMessage(c, 'access-condition');
    if (f === 'irritants') return arrayToList(c.irritants);
    throw badRange(field, 2, 'access-condition');
  });
  def('file-error?', 1, 1, () => false);
  def('read-error?', 1, 1, (x) => x instanceof Condition && x.kind === 'parse-error');

  // ---------- misc ----------
  def('runtime', 0, 0, () => new Flonum(performance.now() / 1000));
  def('%run-number', 0, 0, () => interp.runCount);
  // (%text-numbers! #t) lets arithmetic and indexes accept text such as "05" (see num above)
  def('%text-numbers!', 1, 1, (on) => { interp.textNumbers = on !== false; return UNSPEC; });
  def('%text-numbers?', 0, 0, () => interp.textNumbers);
  def('real-time', 0, 0, () => new Flonum(Date.now()));
  def('current-time', 0, 0, () => Math.floor(Date.now() / 1000));
  def('void', 0, -1, () => UNSPEC);
  def('make-cell', 0, 1, (v) => new Cell(v === undefined ? UNSPEC : v));
  def('cell-contents', 1, 1, (c) => c.v);
  def('set-cell-contents!', 2, 2, (c, v) => { c.v = v; return UNSPEC; });
  def('promise?', 1, 1, (x) => x instanceof Promise_);
  def('make-promise', 1, 1, (v) => { if (v instanceof Promise_) return v; const p = new Promise_(null, null); p.done = true; p.value = v; return p; });
  def('stream-pair?', 1, 1, (x) => x instanceof Pair && x.cdr instanceof Promise_);
  def('procedure-arity', 1, 1, (p) => {
    const [lo, hi] = p instanceof Closure ? [p.lam.nreq, p.lam.rest ? false : p.lam.nreq + p.lam.nopt] : [p.min, p.max < 0 ? false : p.max];
    return new Pair(lo, hi);
  });
  def('record?', 1, 1, (x) => x instanceof Record);
  def('%wrong-type', 3, 3, (obj, i, who) => { throw wrongType(obj, i, stripSym(who).name); });
}
