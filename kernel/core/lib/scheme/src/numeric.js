// Numeric tower: exact integers (JS number when safe, BigInt otherwise),
// exact rationals (Ratnum), inexact reals (Flonum). All functions here expect
// already type-checked numeric arguments; primitives.js does the checking.
import { Flonum, Ratnum } from './types.js';
import { divByZero, schemeError } from './errors.js';

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIG = BigInt(Number.MIN_SAFE_INTEGER);
// Refuse to build astronomically large exact results (would hang the worker).
const MAX_BITS = 4_000_000;

export function normBig(b) {
  return (b >= MIN_SAFE_BIG && b <= MAX_SAFE_BIG) ? Number(b) : b;
}
export const isExactInt = (x) => typeof x === 'number' || typeof x === 'bigint';
export const isFlonum = (x) => x instanceof Flonum;
export const isRatnum = (x) => x instanceof Ratnum;
export const isNumber = (x) => typeof x === 'number' || typeof x === 'bigint' || x instanceof Flonum || x instanceof Ratnum;
export const isExact = (x) => typeof x === 'number' || typeof x === 'bigint' || x instanceof Ratnum;
export const isInteger = (x) => typeof x === 'number' || typeof x === 'bigint' || (x instanceof Flonum && Number.isInteger(x.v));
export const isRational = (x) => !(x instanceof Flonum) || Number.isFinite(x.v);

function bigGcd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) { const t = a % b; a = b; b = t; }
  return a;
}
export function makeRat(n, d) { // BigInt n, d
  if (d === 0n) throw divByZero('/');
  if (d < 0n) { n = -n; d = -d; }
  const g = bigGcd(n, d);
  if (g !== 1n) { n /= g; d /= g; }
  return d === 1n ? normBig(n) : new Ratnum(n, d);
}
function ratParts(x) { // exact -> [n, d] BigInt
  if (x instanceof Ratnum) return [x.n, x.d];
  return [BigInt(x), 1n];
}
export function toFloat(x) {
  if (typeof x === 'number') return x;
  if (x instanceof Flonum) return x.v;
  if (typeof x === 'bigint') return Number(x);
  return ratToFloat(x.n, x.d);
}
// Correctly rounded BigInt ratio -> double (both operands exact in double: plain division is already correct).
function ratToFloat(n, d) {
  const nf = Number(n), df = Number(d);
  if (Math.abs(nf) <= Number.MAX_SAFE_INTEGER && df <= Number.MAX_SAFE_INTEGER) return nf / df;
  const neg = n < 0n;
  if (neg) n = -n;
  const shift = 64 + d.toString(2).length - n.toString(2).length;
  const q = shift >= 0 ? (n << BigInt(shift)) / d : n / (d << BigInt(-shift));
  let r = Number(q), e = -shift;
  while (e > 1000) { r *= 2 ** 1000; e -= 1000; }
  while (e < -1000) { r *= 2 ** -1000; e += 1000; }
  r *= 2 ** e;
  return neg ? -r : r;
}
const level = (x) => (x instanceof Flonum ? 2 : x instanceof Ratnum ? 1 : 0);

// --- arithmetic ------------------------------------------------------------------
export function add(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a + b;
    if (Number.isSafeInteger(r)) return r;
    return normBig(BigInt(a) + BigInt(b));
  }
  const l = Math.max(level(a), level(b));
  if (l === 2) return new Flonum(toFloat(a) + toFloat(b));
  if (l === 1) {
    const [an, ad] = ratParts(a), [bn, bd] = ratParts(b);
    return makeRat(an * bd + bn * ad, ad * bd);
  }
  return normBig(BigInt(a) + BigInt(b));
}
export function sub(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a - b;
    if (Number.isSafeInteger(r)) return r;
    return normBig(BigInt(a) - BigInt(b));
  }
  const l = Math.max(level(a), level(b));
  if (l === 2) return new Flonum(toFloat(a) - toFloat(b));
  if (l === 1) {
    const [an, ad] = ratParts(a), [bn, bd] = ratParts(b);
    return makeRat(an * bd - bn * ad, ad * bd);
  }
  return normBig(BigInt(a) - BigInt(b));
}
export function mul(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a * b;
    if (Number.isSafeInteger(r)) return r + 0; // + 0 turns -0 into 0
    return normBig(BigInt(a) * BigInt(b));
  }
  const l = Math.max(level(a), level(b));
  if (l === 2) {
    // exact zero times anything is exact zero in the reference REPL and R7RS ("(* 0 1.5)" => 0)
    if (a === 0 || b === 0) return 0;
    return new Flonum(toFloat(a) * toFloat(b));
  }
  if (l === 1) {
    const [an, ad] = ratParts(a), [bn, bd] = ratParts(b);
    return makeRat(an * bn, ad * bd);
  }
  const r = BigInt(a) * BigInt(b);
  return normBig(r);
}
export function div(a, b) {
  if (isExact(b) && isZero(b)) throw divByZero('/');
  if (typeof a === 'number' && typeof b === 'number' && a % b === 0) return (a / b) + 0;
  const l = Math.max(level(a), level(b));
  if (l === 2) {
    if (a === 0) return 0;
    return new Flonum(toFloat(a) / toFloat(b));
  }
  const [an, ad] = ratParts(a), [bn, bd] = ratParts(b);
  return makeRat(an * bd, ad * bn);
}
export function negate(a) { return sub(0, a); }

export function isZero(x) {
  if (typeof x === 'number') return x === 0;
  if (x instanceof Flonum) return x.v === 0;
  return false; // BigInt / Ratnum are normalized and never zero
}
export function sign(x) {
  if (typeof x === 'number') return Math.sign(x);
  if (x instanceof Flonum) return Math.sign(x.v);
  if (typeof x === 'bigint') return x < 0n ? -1 : 1;
  return x.n < 0n ? -1 : 1;
}

// Returns -1, 0, 1, or NaN (comparison involving NaN).
export function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  const l = Math.max(level(a), level(b));
  if (l === 2) {
    const x = toFloat(a), y = toFloat(b);
    if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (l === 1) {
    const [an, ad] = ratParts(a), [bn, bd] = ratParts(b);
    const x = an * bd, y = bn * ad;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = BigInt(a), y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// --- integer division ---------------------------------------------------------------
function intArgs(a, b, who) {
  const fl = a instanceof Flonum || b instanceof Flonum;
  const x = a instanceof Flonum ? a.v : a, y = b instanceof Flonum ? b.v : b;
  if (y === 0 || y === 0n) throw divByZero(who);
  return { fl, x, y };
}
function wrapInt(r, fl) { return fl ? new Flonum(Number(r)) : r; }

export function quotient(a, b, who = 'integer-quotient') {
  const { fl, x, y } = intArgs(a, b, who);
  if (typeof x === 'number' && typeof y === 'number') {
    return wrapInt(((x - (x % y)) / y) + 0, fl);
  }
  return wrapInt(normBig(BigInt(x) / BigInt(y)), fl);
}
export function remainder(a, b, who = 'integer-remainder') {
  const { fl, x, y } = intArgs(a, b, who);
  if (typeof x === 'number' && typeof y === 'number') return wrapInt((x % y) + 0, fl);
  return wrapInt(normBig(BigInt(x) % BigInt(y)), fl);
}
export function modulo(a, b, who = 'integer-modulo') {
  const { fl, x, y } = intArgs(a, b, who);
  if (typeof x === 'number' && typeof y === 'number') {
    let r = x % y;
    if (r !== 0 && (r < 0) !== (y < 0)) r += y;
    return wrapInt(r + 0, fl);
  }
  const bx = BigInt(x), by = BigInt(y);
  let r = bx % by;
  if (r !== 0n && (r < 0n) !== (by < 0n)) r += by;
  return wrapInt(normBig(r), fl);
}
export function gcd(a, b) {
  if (a instanceof Flonum || b instanceof Flonum) {
    return new Flonum(Number(bigGcd(BigInt(toFloat(a)), BigInt(toFloat(b)))));
  }
  return normBig(bigGcd(BigInt(a), BigInt(b)));
}
export function lcm(a, b) {
  if (isZero(a) || isZero(b)) return 0;
  const g = gcd(a, b);
  const r = abs(mul(a, quotient(b, g)));
  return r;
}
export function abs(x) { return sign(x) < 0 ? negate(x) : x; }

// --- floor / ceiling / round / truncate ---------------------------------------------
function floorDiv(n, d) { // BigInt, d > 0
  let q = n / d;
  if (n % d !== 0n && n < 0n) q -= 1n;
  return q;
}
export function floor(x) {
  if (x instanceof Flonum) return new Flonum(Math.floor(x.v));
  if (x instanceof Ratnum) return normBig(floorDiv(x.n, x.d));
  return x;
}
export function ceiling(x) {
  if (x instanceof Flonum) return new Flonum(Math.ceil(x.v));
  if (x instanceof Ratnum) return normBig(floorDiv(x.n, x.d) + 1n);
  return x;
}
export function truncate(x) {
  if (x instanceof Flonum) return new Flonum(Math.trunc(x.v));
  if (x instanceof Ratnum) return normBig(x.n / x.d);
  return x;
}
function roundHalfEven(v) {
  const f = Math.floor(v), diff = v - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}
export function round(x) {
  if (x instanceof Flonum) return new Flonum(roundHalfEven(x.v));
  if (x instanceof Ratnum) {
    const f = floorDiv(x.n, x.d);
    const twice = 2n * (x.n - f * x.d);
    if (twice < x.d) return normBig(f);
    if (twice > x.d) return normBig(f + 1n);
    return normBig(f % 2n === 0n ? f : f + 1n);
  }
  return x;
}

// --- exactness conversion ---------------------------------------------------------------
export function toExact(x) {
  if (!(x instanceof Flonum)) return x;
  const v = x.v;
  if (!Number.isFinite(v)) throw schemeError('Integer too large to be converted to exact:', x);
  if (Number.isInteger(v)) return Number.isSafeInteger(v) ? v + 0 : normBig(BigInt(v));
  let m = v, e = 0n;
  while (!Number.isInteger(m)) { m *= 2; e++; }
  return makeRat(BigInt(m), 1n << e);
}
export function toInexact(x) {
  return x instanceof Flonum ? x : new Flonum(toFloat(x));
}

// --- powers and roots ---------------------------------------------------------------
export function isqrtBig(n) { // floor(sqrt(n)), n >= 0n
  if (n < 2n) return n;
  // Newton's method from an overestimate; strictly decreasing until it settles.
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}
export function sqrt(x) {
  if (x instanceof Flonum) {
    if (x.v < 0) throw schemeError('Complex results are not supported: sqrt of', x);
    return new Flonum(Math.sqrt(x.v));
  }
  if (sign(x) < 0) throw schemeError('Complex results are not supported: sqrt of', x);
  if (x instanceof Ratnum) {
    const rn = isqrtBig(x.n), rd = isqrtBig(x.d);
    if (rn * rn === x.n && rd * rd === x.d) return makeRat(rn, rd);
    return new Flonum(Math.sqrt(toFloat(x)));
  }
  const b = BigInt(x), r = isqrtBig(b);
  if (r * r === b) return normBig(r);
  return new Flonum(Math.sqrt(Number(b)));
}
export function exactIntegerSqrt(x) { // -> [s, r]
  const b = BigInt(x), s = isqrtBig(b);
  return [normBig(s), normBig(b - s * s)];
}
export function expt(base, e) {
  if (isExactInt(e)) {
    if (base instanceof Flonum) return new Flonum(Math.pow(base.v, Number(e)));
    const n = BigInt(e);
    if (n >= 0n) {
      const bits = (base instanceof Ratnum ? Math.max(base.n.toString(2).length, base.d.toString(2).length) : BigInt(base).toString(2).length);
      if (bits > 1 && n * BigInt(bits) > BigInt(MAX_BITS)) throw schemeError('Result of expt is too large:', base, e);
      if (base instanceof Ratnum) return makeRat(base.n ** n, base.d ** n);
      return normBig(BigInt(base) ** n);
    }
    if (isZero(base)) throw divByZero('/');
    return div(1, expt(base, normBig(-n)));
  }
  const r = Math.pow(toFloat(base), toFloat(e));
  return new Flonum(r);
}

// --- number <-> string -------------------------------------------------------------------
export function floatToString(v) {
  if (Number.isNaN(v)) return '+nan.0';
  if (v === Infinity) return '+inf.0';
  if (v === -Infinity) return '-inf.0';
  if (Object.is(v, -0)) return '-0.0';
  let s = String(v);
  if (s.indexOf('e') >= 0) return s.replace('e+', 'e');
  if (s.indexOf('.') < 0) s += '.0';
  return s;
}
export function numberToString(x, radix = 10) {
  if (typeof x === 'number' || typeof x === 'bigint') return x.toString(radix);
  if (x instanceof Ratnum) return x.n.toString(radix) + '/' + x.d.toString(radix);
  return radix === 10 ? floatToString(x.v) : x.v.toString(radix);
}

function parseUInt(s, radix) {
  const digits = radix === 10 ? /^[0-9]+$/ : radix === 16 ? /^[0-9a-fA-F]+$/ : radix === 8 ? /^[0-7]+$/ : /^[01]+$/;
  if (!digits.test(s)) return null;
  if (radix === 10 && s.length < 16) return parseInt(s, 10);
  const prefix = radix === 16 ? '0x' : radix === 8 ? '0o' : radix === 2 ? '0b' : '';
  return normBig(BigInt(prefix + s));
}
// Returns a Scheme number or null if `str` is not numeric syntax.
export function parseNumber(str, radix = 10) {
  let exactness = null;
  while (str.length >= 2 && str[0] === '#') {
    const c = str[1].toLowerCase();
    if (c === 'x') radix = 16; else if (c === 'b') radix = 2; else if (c === 'o') radix = 8; else if (c === 'd') radix = 10;
    else if (c === 'e' || c === 'i') exactness = c;
    else return null;
    str = str.slice(2);
  }
  let r = parseReal(str, radix);
  if (r === null) return null;
  if (exactness === 'e') r = toExact(r);
  else if (exactness === 'i') r = toInexact(r);
  return r;
}
function parseReal(str, radix) {
  if (str === '+inf.0') return new Flonum(Infinity);
  if (str === '-inf.0') return new Flonum(-Infinity);
  if (str === '+nan.0' || str === '-nan.0') return new Flonum(NaN);
  let sgn = 1, body = str;
  if (body[0] === '+') body = body.slice(1);
  else if (body[0] === '-') { sgn = -1; body = body.slice(1); }
  if (body.length === 0) return null;
  const slash = body.indexOf('/');
  if (slash > 0) {
    const n = parseUInt(body.slice(0, slash), radix), d = parseUInt(body.slice(slash + 1), radix);
    if (n === null || d === null) return null;
    if (d === 0) return null;
    return makeRat(BigInt(n) * BigInt(sgn), BigInt(d));
  }
  const i = parseUInt(body, radix);
  if (i !== null) return sgn < 0 ? negate(i) : i;
  if (radix !== 10) return null;
  if (/^([0-9]+\.?[0-9]*|\.[0-9]+)(e[+-]?[0-9]+)?$/i.test(body)) {
    const v = parseFloat(body);
    return new Flonum(sgn * v);
  }
  return null;
}

// --- misc ------------------------------------------------------------------------------------
export function eqvNum(a, b) { // exactness-aware equality (eqv? on numbers)
  if (typeof a === 'number' || typeof a === 'bigint') return a === b;
  if (a instanceof Flonum) return b instanceof Flonum && (a.v === b.v ? (a.v !== 0 || Object.is(a.v, b.v)) : (Number.isNaN(a.v) && Number.isNaN(b.v)));
  if (a instanceof Ratnum) return b instanceof Ratnum && a.n === b.n && a.d === b.d;
  return false;
}
export function parity(x) { // 0 even, 1 odd; x integer
  if (typeof x === 'number') return Math.abs(x % 2);
  if (typeof x === 'bigint') return Number(x & 1n);
  return Math.abs(x.v % 2);
}
export function randomBelow(n) { // n: positive exact integer or flonum
  if (n instanceof Flonum) return new Flonum(Math.random() * n.v);
  if (typeof n === 'number') return Math.floor(Math.random() * n);
  const bits = n.toString(2).length + 16;
  let r = 0n;
  for (let i = 0; i < bits; i += 30) r = (r << 30n) | BigInt(Math.floor(Math.random() * (1 << 30)));
  return normBig(r % n);
}
