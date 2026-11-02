// Core data types for the Scheme engine. No DOM / Worker globals anywhere in src/.

// --- symbols ---------------------------------------------------------------
// Interned symbols compare with ===. An "alias" is an uninterned symbol made by
// the syntax-rules expander for template-introduced identifiers: `base` is the
// symbol it stands for and `env` the scope the macro was defined in (null = global).
export class Sym {
  constructor(name, base = null, env = null) {
    this.name = name;
    this.base = base;
    this.env = env;
  }
  toString() { return this.name; }
}
const symtab = new Map();
export function intern(name) {
  let s = symtab.get(name);
  if (!s) { s = new Sym(name); symtab.set(name, s); }
  return s;
}
let gensymCount = 0;
export function gensym(prefix = 'g') { return new Sym(prefix + (++gensymCount)); }
export function makeAlias(sym, env) { return new Sym(sym.name, sym, env); }
export function stripSym(s) { while (s.base) s = s.base; return s; }

// --- pairs and singletons --------------------------------------------------
export class Pair {
  constructor(car, cdr) { this.car = car; this.cdr = cdr; }
}
class Singleton {
  constructor(name) { this.name = name; }
  toString() { return this.name; }
}
export const NIL = new Singleton('()');
export const UNSPEC = new Singleton('#!unspecific');
export const DEFAULT = new Singleton('#!default');
export const EOF = new Singleton('#[eof]');
export const UNASSIGNED = new Singleton('#!unassigned');
export const UNBOUND = new Singleton('#!unbound');

// --- other atoms -------------------------------------------------------------
export class Char {
  constructor(cp) { this.cp = cp; }
}
const charCache = new Map();
export function makeChar(cp) {
  let c = charCache.get(cp);
  if (!c) { c = new Char(cp); if (cp < 256) charCache.set(cp, c); }
  return c;
}

// Scheme strings are mutable, so they are boxed (eq? needs identity).
export class SString {
  constructor(s) { this.s = s; }
}

// Numbers: exact integer = JS number (always a safe integer) or BigInt (outside
// the safe range); exact rational = Ratnum; inexact real = Flonum (boxed, so 3
// and 3.0 stay distinguishable).
export class Flonum { constructor(v) { this.v = v; } }
export class Ratnum { constructor(n, d) { this.n = n; this.d = d; } } // BigInt n, d > 1n, lowest terms

export class Values { constructor(vals) { this.vals = vals; } }

// --- procedures and runtime objects -----------------------------------------------
export class Closure {
  constructor(lam, env) { this.lam = lam; this.env = env; }
}
// Plain primitive: fn receives Scheme values positionally.
export class Primitive {
  constructor(name, min, max, fn) { this.name = name; this.min = min; this.max = max; this.fn = fn; }
}
// Machine primitive: fn(machine, vals) manipulates machine registers directly
// (vals[0] is the procedure itself, arguments start at vals[1]).
export class MPrim {
  constructor(name, min, max, fn) { this.name = name; this.min = min; this.max = max; this.fn = fn; }
}
export class Continuation {
  constructor(k, winders, handlers) { this.k = k; this.winders = winders; this.handlers = handlers; }
}
export class Parameter {
  constructor(value, converter) { this.value = value; this.converter = converter; }
}
export class Promise_ {
  constructor(node, env) { this.done = false; this.value = undefined; this.node = node; this.env = env; }
}
export class Environment { constructor(name) { this.name = name; } }
// The environment of a procedure body or `let`: the compile-time scope plus the
// runtime frame it was captured with, so `eval` can analyze against the same names.
export class LexicalEnv extends Environment {
  constructor(scope, frame) { super('local'); this.scope = scope; this.frame = frame; }
}
export class RecordType {
  constructor(name, fields) { this.name = name; this.fields = fields; }
}
export class Record {
  constructor(type, vals) { this.type = type; this.vals = vals; }
}
// define-datatype support: a datatype owns its variants; a Variant is one constructed value.
export class DataType {
  constructor(name) { this.name = name; this.variants = new Map(); } // variant name -> field names
}
export class Variant {
  constructor(dt, name, vals) { this.dt = dt; this.name = name; this.vals = vals; }
}
export class HashTable {
  constructor(kind) { this.kind = kind; this.map = new Map(); }
}
export class Cell { constructor(v) { this.v = v; } }
export class Box { // global variable cell
  constructor(name, v) { this.name = name; this.v = v; }
}

// Ports. Output ports collect into `buf` (string ports) or forward to `sink` (console).
export class Port {
  constructor(kind) {
    this.kind = kind;     // 'out-string' | 'in-string' | 'console-out' | 'console-in'
    this.buf = '';
    this.input = '';
    this.pos = 0;
    this.col = 0;         // output column, for fresh-line
  }
}

// --- errors --------------------------------------------------------------------
// A Scheme condition object (what `error`, primitive failures etc. raise).
export class Condition {
  constructor(kind, message, irritants = [], extra = null) {
    this.kind = kind;       // 'simple-error' | 'wrong-type' | 'bad-range' | 'unbound-variable' | ...
    this.message = message; // JS string, or any Scheme value for simple-error
    this.irritants = irritants;
    this.extra = extra;
  }
}
// JS exception carrying a raised Scheme object up to the machine's catch block.
export class SchemeThrow {
  constructor(payload, continuable = false) { this.payload = payload; this.continuable = continuable; }
}
// Non-catchable terminations.
export class SchemeAbort { constructor(message) { this.message = message; } }
export class SchemeExit { constructor(code) { this.code = code; } }

// --- list helpers ---------------------------------------------------------------
export function list(...items) {
  let r = NIL;
  for (let i = items.length - 1; i >= 0; i--) r = new Pair(items[i], r);
  return r;
}
export function arrayToList(arr, tail = NIL) {
  let r = tail;
  for (let i = arr.length - 1; i >= 0; i--) r = new Pair(arr[i], r);
  return r;
}
// Proper list -> JS array, or null if improper/cyclic.
export function listToArray(l) {
  const out = [];
  let slow = l, n = 0;
  while (l instanceof Pair) {
    out.push(l.car);
    l = l.cdr;
    if ((++n & 1) === 0) { slow = slow.cdr; if (slow === l && l instanceof Pair) return null; }
  }
  return l === NIL ? out : null;
}
export function isList(l) { return listToArray(l) !== null; }
