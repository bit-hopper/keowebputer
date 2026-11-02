// The machine (MLspec.md section 6.5): an explicit-continuation loop over the IR that `Elaborator` produces (documented at
// the top of infer.js). Continuations are heap frames, so non-tail recursion is limited by memory (and a depth cap), not by the
// JS stack, and a tail call pushes nothing.
//
//   const run = new ItemRun(elaborated.ir, globals);     // links the item against the committed global bindings
//   while (run.step(25) === 'running') { ... yield ... }  // time-sliced; run.interrupt() is seen between slices
//   run.state: 'done' | 'raised' (run.exn is the uncaught exception value) | 'limit' (stack depth) | 'stopped'
//   if (run.state === 'done') run.commit();               // only now do the item's bindings become visible
//
// `globals` is a Map name -> cell ({name, value}); makeGlobals() makes the initial one. A top-level binding is a fresh cell
// every time, and the linker resolves each free name of an item to the cell that is current when the item starts, so a closure
// keeps the binding it was written against even if the name is later redefined (static scope). Local bindings are linked
// frames {name, value, next} in the environment.
import { MLError } from './errors.js';
import { FALSE_INFO, TRUE_INFO, NIL_INFO, CONS_INFO } from './basis.js';
import {
  BUILTIN_EXN, Overflow, makeExcon, exnValue, normInt, valuesEqual, charValue, intText,
  intAdd, intSub, intMul, intNeg, intDiv, intMod,
} from './values.js';

const LOCAL = { local: true }; // scope marker: bound in the run-time environment, not in a cell
const FAIL = undefined; // a pattern that did not match (the empty environment is `null`)

// ---- values the machine hands out ------------------------------------------------------------------------------

const conValue = (info) => info._value || (info._value = { tag: 'con', con: info, arg: undefined });
const conFn = (info) => info._fn || (info._fn = { tag: 'confn', con: info });
const TRUE = conValue(TRUE_INFO);
const FALSE = conValue(FALSE_INFO);
const bool = (b) => (b ? TRUE : FALSE);
const isTrue = (v) => v.con.index === 1; // (constructors compare by index: a functor's copies of a datatype are different objects)

class RaiseSignal { constructor(exn) { this.exn = exn; } }
const divZero = () => new RaiseSignal(BUILTIN_EXN.Div);
const raiseExn = (name) => new RaiseSignal(BUILTIN_EXN[name]);

// ---- lists: ordinary datatype values with stable constructors (basis.js), plus helpers for the primitives ---------------

const UNIT = [];
const NIL = conValue(NIL_INFO);
const consCell = (head, tail) => ({ tag: 'con', con: CONS_INFO, arg: [head, tail] });
const isNil = (l) => l.con.index === 0;
function listToArray(l) {
  const out = [];
  while (!isNil(l)) { out.push(l.arg[0]); l = l.arg[1]; }
  return out;
}
function arrayToList(a, tail = NIL) {
  let l = tail;
  for (let i = a.length - 1; i >= 0; i--) l = consCell(a[i], l);
  return l;
}

// The binary primitives take their two operands directly (the linker calls them without building the pair when both operands
// are written out); PRIM_FN takes the pair, for the general case where the argument is any expression.
const PRIM2 = {
  '+': intAdd,
  '-': intSub,
  '*': intMul,
  div: (a, b) => { if (b === 0) throw divZero(); return intDiv(a, b); },
  mod: (a, b) => { if (b === 0) throw divZero(); return intMod(a, b); },
  '<': (a, b) => bool(typeof a === 'object' ? a.c < b.c : a < b), // (ints, strings; a char is an object)
  '>': (a, b) => bool(typeof a === 'object' ? a.c > b.c : a > b),
  '<=': (a, b) => bool(typeof a === 'object' ? a.c <= b.c : a <= b),
  '>=': (a, b) => bool(typeof a === 'object' ? a.c >= b.c : a >= b),
  '=': (a, b) => bool(a === b || valuesEqual(a, b)),
  '<>': (a, b) => bool(a !== b && !valuesEqual(a, b)),
  '^': (a, b) => a + b,
  '@': (a, b) => (isNil(a) ? b : arrayToList(listToArray(a), b)),
};
// One-argument primitives take (argument, run): `print` needs the run's output sink. The strings and characters are JS strings and
// interned char objects (a char is a UTF-16 unit, like a JS string index).
const PRIM_FN = {
  '~': (a) => intNeg(a),
  not: (a) => bool(!isTrue(a)),
  size: (s) => s.length,
  hd: (l) => { if (isNil(l)) throw raiseExn('Empty'); return l.arg[0]; },
  tl: (l) => { if (isNil(l)) throw raiseExn('Empty'); return l.arg[1]; },
  null: (l) => bool(isNil(l)),
  length: (l) => { let n = 0; while (!isNil(l)) { n++; l = l.arg[1]; } return n; },
  rev: (l) => { let r = NIL; while (!isNil(l)) { r = consCell(l.arg[0], r); l = l.arg[1]; } return r; },
  print: (s, run) => { run.out(s); return UNIT; },
  str: (c) => c.c,
  ord: (c) => c.c.charCodeAt(0),
  chr: (n) => { if (typeof n !== 'number' || n < 0 || n > 0xFFFF) throw raiseExn('Chr'); return charValue(String.fromCharCode(n)); },
  explode: (s) => { const out = new Array(s.length); for (let i = 0; i < s.length; i++) out[i] = charValue(s[i]); return arrayToList(out); },
  implode: (l) => listToArray(l).map((c) => c.c).join(''),
  concat: (l) => listToArray(l).join(''),
  'Int.toString': (n) => intText(n),
};
for (const name of Object.keys(PRIM2)) PRIM_FN[name] = (a) => PRIM2[name](a[0], a[1]);
const primValue = (name) => ({ tag: 'prim', name, fn: PRIM_FN[name] });

export function makeGlobals() {
  const globals = new Map();
  for (const name of Object.keys(BUILTIN_EXN)) globals.set(name, { name, value: BUILTIN_EXN[name] });
  return globals;
}

// ---- linking: resolve every free name of an item ------------------------------------------------------------------

function patVars(p, out) {
  switch (p.p) {
    case 'var': out.push(p.name); break;
    case 'con': case 'exn': if (p.arg) patVars(p.arg, out); break;
    case 'tuple': p.items.forEach((x) => patVars(x, out)); break;
    default: break;
  }
  return out;
}

const child = (parent) => ({ map: new Map(), parent });

class Linker {
  constructor(globals) {
    this.globals = globals;
    this.pending = new Map(); // the cells this item creates at top level
  }

  lookup(sc, name) {
    for (let s = sc; s; s = s.parent) if (s.map.has(name)) return s.map.get(name);
    const cell = this.globals.get(name);
    if (!cell) throw new MLError('internal', 'machine: unbound name ' + name);
    return cell;
  }

  pat(p, sc) {
    switch (p.p) {
      case 'int': p.value = normInt(p.value); break;
      case 'chr': p.cv = charValue(p.value); break;
      case 'con': if (p.arg) this.pat(p.arg, sc); break;
      case 'exn': {
        if (p.qual) p.skey = 'S:' + p.qual[0];
        const r = this.lookup(sc, p.qual ? p.skey : p.name);
        p.cell = r === LOCAL ? null : r;
        if (p.arg) this.pat(p.arg, sc);
        break;
      }
      case 'tuple': p.items.forEach((x) => this.pat(x, sc)); break;
      default: break;
    }
  }

  // Link an expression; sets `atomic` (evaluable without pushing a frame) on every node.
  exp(n, sc) {
    switch (n.op) {
      case 'const': if (typeof n.value === 'number' || typeof n.value === 'bigint') n.value = normInt(n.value); n.atomic = true; n.t = A_CONST; break;
      case 'var': {
        const r = this.lookup(sc, n.name);
        n.cell = r === LOCAL ? null : r;
        n.atomic = true;
        n.t = n.cell ? A_GLOBAL : A_LOCAL;
        break;
      }
      case 'con': n.val = n.con.hasArg ? conFn(n.con) : conValue(n.con); n.atomic = true; n.t = A_VAL; break;
      case 'prim': n.val = primValue(n.name); n.atomic = true; n.t = A_VAL; break;
      case 'qvar': { // S.x: the structure S is a local frame or a top-level cell
        n.key = 'S:' + n.path[0];
        const r = this.lookup(sc, n.key);
        n.cell = r === LOCAL ? null : r;
        n.atomic = true;
        n.t = A_QVAR;
        break;
      }
      case 'tuple': n.items.forEach((x) => this.exp(x, sc)); n.atomic = n.items.every((x) => x.atomic); n.t = A_TUPLE; break;
      case 'list': n.items.forEach((x) => this.exp(x, sc)); n.atomic = n.items.every((x) => x.atomic); n.t = A_LIST; break;
      case 'conapp': this.exp(n.arg, sc); n.atomic = n.arg.atomic; n.t = A_CONAPP; break;
      case 'app':
        this.exp(n.fn, sc);
        this.exp(n.arg, sc);
        if (n.fn.op === 'prim') {
          n.primFn = PRIM_FN[n.fn.name];
          if (PRIM2[n.fn.name] && n.arg.op === 'tuple') { // `a + b`: no pair is built when both operands are atomic
            n.prim2 = PRIM2[n.fn.name];
            n.left = n.arg.items[0];
            n.right = n.arg.items[1];
          }
        }
        n.atomic = !!n.primFn && n.arg.atomic;
        n.t = n.prim2 ? A_PRIM2 : A_PRIM1;
        break;
      case 'if': this.exp(n.cond, sc); this.exp(n.then, sc); this.exp(n.else, sc); n.atomic = false; break;
      case 'fn': this.rules(n.rules, sc); n.atomic = true; n.t = A_FN; break;
      case 'let': {
        const inner = this.decs(n.decs, sc, false);
        this.exp(n.body, inner);
        n.atomic = false;
        break;
      }
      case 'raise': this.exp(n.exp, sc); n.atomic = false; break;
      case 'handle': this.exp(n.exp, sc); this.rules(n.rules, sc); n.atomic = false; break;
      default: throw new MLError('internal', 'machine: unknown expression ' + n.op);
    }
  }

  rules(rules, sc) {
    for (const r of rules) {
      const inner = child(sc);
      for (const v of patVars(r.pat, [])) inner.map.set(v, LOCAL);
      this.pat(r.pat, sc);
      this.exp(r.body, inner);
    }
  }

  // The names a declaration binds get cells (top level) or LOCAL entries; returns the scope that includes them.
  bind(names, sc, top, d) {
    const inner = child(sc);
    d.cells = top ? new Map() : null;
    for (const name of names) {
      if (top) {
        const cell = { name, value: undefined };
        this.pending.set(name, cell);
        inner.map.set(name, cell);
        d.cells.set(name, cell);
      } else inner.map.set(name, LOCAL);
    }
    return inner;
  }

  dec(d, sc, top) {
    switch (d.d) {
      case 'val': {
        const names = [];
        d.binds.forEach((b) => patVars(b.pat, names));
        const recNames = d.recs.map((r) => r.name);
        const after = this.bind(names.concat(recNames), sc, top, d);
        for (const b of d.binds) { this.pat(b.pat, sc); this.exp(b.exp, sc); }
        const recScope = child(sc); // the rec bindings see only their own names (and what was there before)
        for (const name of recNames) recScope.map.set(name, after.map.get(name));
        for (const r of d.recs) this.exp(r.exp, recScope);
        return after;
      }
      case 'exception': return this.bind(d.binds.map((b) => b.name), sc, top, d);
      case 'structure': {
        const after = this.bind(d.binds.map((b) => 'S:' + b.name), sc, top, d);
        for (const b of d.binds) this.str(b.str, sc);
        return after;
      }
      case 'functor': {
        const inner = child(sc);
        inner.map.set('S:' + d.param, LOCAL);
        this.str(d.body, inner);
        return this.bind(['F:' + d.name], sc, top, d);
      }
      case 'open': {
        d.key = 'S:' + d.path[0];
        const r = this.lookup(sc, d.key);
        d.cell = r === LOCAL ? null : r;
        return this.bind(d.vals.concat(d.strs.map((n) => 'S:' + n)), sc, false, d);
      }
      case 'local': {
        const headScope = this.decs(d.head, sc, false);
        const bodyScope = this.decs(d.body, headScope, top);
        // only the body's own bindings escape: re-root them on `sc`
        const out = child(sc);
        for (let s = bodyScope; s && s !== headScope; s = s.parent) for (const [k, v] of s.map) if (!out.map.has(k)) out.map.set(k, v);
        return out;
      }
      default: throw new MLError('internal', 'machine: unknown declaration ' + d.d);
    }
  }

  // structure expressions
  str(s, sc) {
    switch (s.s) {
      case 'path': {
        s.key = 'S:' + s.path[0];
        const r = this.lookup(sc, s.key);
        s.cell = r === LOCAL ? null : r;
        break;
      }
      case 'struct': this.decs(s.decs, sc, false); break;
      case 'apply': {
        s.fkey = 'F:' + s.fun;
        const r = this.lookup(sc, s.fkey);
        s.fcell = r === LOCAL ? null : r;
        this.str(s.arg, sc);
        break;
      }
      case 'thin': this.str(s.str, sc); break;
      case 'let': this.str(s.body, this.decs(s.decs, sc, false)); break;
      default: throw new MLError('internal', 'machine: unknown structure expression ' + s.s);
    }
  }

  decs(list, sc, top) {
    let cur = sc;
    for (const d of list) cur = this.dec(d, cur, top);
    return cur;
  }
}

// ---- patterns ------------------------------------------------------------------------------------------------------

function lookupEnv(env, name) {
  for (let f = env; f; f = f.next) if (f.name === name) return f.value;
  throw new MLError('internal', 'machine: unbound local ' + name);
}

// Match `v` against `p`, extending `env`; FAIL (undefined) when it does not match.
function matchPat(p, v, env) {
  switch (p.p) {
    case 'wild': return env;
    case 'var': return { name: p.name, value: v, next: env };
    case 'int': return v === p.value ? env : FAIL;
    case 'str': return v === p.value ? env : FAIL;
    case 'chr': return v === p.cv ? env : FAIL;
    case 'con':
      if (v.con.index !== p.con.index) return FAIL;
      return p.arg ? matchPat(p.arg, v.arg, env) : env;
    case 'exn': {
      if (v.tag !== 'exn') return FAIL;
      let ev;
      if (p.qual) {
        let st = p.cell ? p.cell.value : lookupEnv(env, p.skey);
        for (let i = 1; i < p.qual.length; i++) st = st.s.get(p.qual[i]);
        ev = st.v.get(p.name);
      } else ev = p.cell ? p.cell.value : lookupEnv(env, p.name);
      if (v.excon !== (ev.tag === 'exn' ? ev.excon : ev)) return FAIL;
      return p.arg ? matchPat(p.arg, v.arg, env) : env;
    }
    case 'tuple': {
      let e = env;
      for (let i = 0; i < p.items.length; i++) {
        e = matchPat(p.items[i], v[i], e);
        if (e === FAIL) return FAIL;
      }
      return e;
    }
    default: throw new MLError('internal', 'machine: unknown pattern ' + p.p);
  }
}

// ---- structures at run time -----------------------------------------------------------------------------------------
// A structure value is {tag:'struct', v: Map name -> value, s: Map name -> structure}.

function buildStruct(env, ir) {
  const v = new Map();
  const s = new Map();
  for (const name of ir.vals) v.set(name, lookupEnv(env, name));
  for (const c of ir.cons) v.set(c.name, c.con.hasArg ? conFn(c.con) : conValue(c.con));
  for (const name of ir.strs) s.set(name, lookupEnv(env, 'S:' + name));
  return { tag: 'struct', v, s };
}

// What a signature lets through: the listed values and, recursively, substructures.
function thinStruct(st, spec) {
  const v = new Map();
  const s = new Map();
  for (const name of spec.vals) v.set(name, st.v.get(name));
  for (const name of Object.keys(spec.strs)) s.set(name, thinStruct(st.s.get(name), spec.strs[name]));
  return { tag: 'struct', v, s };
}

// ---- the machine ---------------------------------------------------------------------------------------------------

const EVAL = 0; const RET = 1; const APPLY = 2; const RAISE = 3;
// continuation frames
const K_HALT = 0; const K_APP1 = 1; const K_APP2 = 2; const K_TUPLE = 3; const K_CONAPP = 4; const K_IF = 5; const K_RAISE = 6;
const K_HANDLE = 7; const K_DECS = 8; const K_VAL = 9; const K_LETBODY = 10; const K_LOCALBODY = 11; const K_LOCALEND = 12;
const K_STRUCT_END = 13; const K_APPLYF = 14; const K_THIN = 15; const K_LETSTR = 16; const K_STRBIND = 17;

// what `atom` does with a node (set by the linker)
const A_LOCAL = 0; const A_CONST = 1; const A_GLOBAL = 2; const A_PRIM2 = 3; const A_VAL = 4; const A_FN = 5; const A_PRIM1 = 6; const A_TUPLE = 7; const A_CONAPP = 8; const A_QVAR = 9;
const A_LIST = 10;

const LIMIT = { limit: true };
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Frames, not calls: a non-tail recursion costs one frame a level, so this allows recursion more than 2 million deep.
export const DEFAULT_MAX_DEPTH = 2500000;

export class ItemRun {
  constructor(ir, globals, options = {}) {
    this.globals = globals;
    this.maxDepth = options.maxDepth || DEFAULT_MAX_DEPTH;
    this.out = options.out || (() => {}); // where `print` writes
    this.limitReason = null; // 'depth' | 'memory' when state is 'limit'
    const linker = new Linker(globals);
    linker.decs(ir.decs, null, true);
    this.pending = linker.pending;
    this.state = 'running';
    this.exn = null;
    this.interrupted = false;
    this.steps = 0;
    const halt = { k: K_HALT, next: null, depth: 0 };
    this.kont = this.frame(K_DECS, halt, ir.decs, 0, null, true); // a = decs, b = next index, c = env, d = top
    this.mode = RET;
    this.value = null;
    this.node = null;
    this.env = null;
    this.fn = null;
  }

  commit() { for (const [name, cell] of this.pending) this.globals.set(name, cell); }

  interrupt() { this.interrupted = true; }

  frame(k, next, a, b, c, d, e) {
    const depth = next.depth + 1;
    if (depth > this.maxDepth) throw LIMIT;
    return { k, next, depth, a, b, c, d, e };
  }

  // Run for about `budgetMs`; returns the state ('running' means: call again).
  step(budgetMs) {
    const deadline = now() + budgetMs;
    let n = 0;
    while (this.state === 'running') {
      try {
        for (;;) {
          switch (this.mode) {
            case EVAL: this.evalNode(); break;
            case RET: this.ret(); break;
            case APPLY: this.apply(); break;
            default: this.raise(); break;
          }
          if (this.state !== 'running') break;
          if ((++n & 1023) === 0) {
            this.steps += 1024;
            if (this.interrupted) { this.state = 'stopped'; break; }
            if (now() >= deadline) return this.state;
          }
        }
      } catch (e) {
        if (e instanceof RaiseSignal) { this.value = e.exn; this.mode = RAISE; } else if (e instanceof Overflow) { this.value = BUILTIN_EXN.Overflow; this.mode = RAISE; } else if (e === LIMIT) {
          this.state = 'limit';
          this.limitReason = 'depth';
          this.kont = null;
        } else if (e instanceof RangeError) { // a string or array past what the engine can hold
          this.state = 'limit';
          this.limitReason = 'memory';
          this.kont = null;
        } else throw e;
      }
    }
    return this.state;
  }

  // Value of an expression that needs no frame.
  atom(n, env) {
    switch (n.t) {
      case A_LOCAL: {
        const name = n.name;
        for (let f = env; f; f = f.next) if (f.name === name) return f.value;
        return lookupEnv(env, name);
      }
      case A_CONST: return n.value;
      case A_GLOBAL: return n.cell.value;
      case A_PRIM2: return n.prim2(this.atom(n.left, env), this.atom(n.right, env));
      case A_VAL: return n.val;
      case A_FN: return { tag: 'closure', rules: n.rules, env };
      case A_PRIM1: return n.primFn(this.atom(n.arg, env), this);
      case A_TUPLE: {
        const items = n.items;
        const out = new Array(items.length);
        for (let i = 0; i < items.length; i++) out[i] = this.atom(items[i], env);
        return out;
      }
      case A_CONAPP: return { tag: 'con', con: n.con, arg: this.atom(n.arg, env) };
      case A_LIST: {
        const items = n.items;
        const vals = new Array(items.length);
        for (let i = 0; i < items.length; i++) vals[i] = this.atom(items[i], env); // (left to right)
        return arrayToList(vals);
      }
      case A_QVAR: {
        let st = n.cell ? n.cell.value : lookupEnv(env, n.key);
        for (let i = 1; i < n.path.length; i++) st = st.s.get(n.path[i]);
        return st.v.get(n.name);
      }
      default: throw new MLError('internal', 'machine: not atomic: ' + n.op);
    }
  }

  evalNode() {
    const n = this.node;
    const env = this.env;
    if (n.s !== undefined) { this.evalStr(n, env); return; }
    if (n.atomic) { this.value = this.atom(n, env); this.mode = RET; return; }
    switch (n.op) {
      case 'app':
        if (n.fn.atomic) {
          const fv = this.atom(n.fn, env);
          if (n.arg.atomic) { this.fn = fv; this.value = this.atom(n.arg, env); this.mode = APPLY; } else if (n.primFn && n.arg.op === 'tuple') {
            // `1 + f(x)`: the tuple frame applies the primitive itself, so a non-tail recursion costs one frame a level
            this.kont = this.frame(K_TUPLE, this.kont, n.arg, 0, new Array(n.arg.items.length), env, n.primFn);
            this.tupleNext();
          } else {
            this.kont = this.frame(K_APP2, this.kont, fv);
            this.node = n.arg;
          }
        } else {
          this.kont = this.frame(K_APP1, this.kont, n.arg, env);
          this.node = n.fn;
        }
        return;
      case 'tuple': this.kont = this.frame(K_TUPLE, this.kont, n, 0, new Array(n.items.length), env); this.tupleNext(); return;
      case 'list': this.kont = this.frame(K_TUPLE, this.kont, n, 0, new Array(n.items.length), env, arrayToList); this.tupleNext(); return;
      case 'conapp': this.kont = this.frame(K_CONAPP, this.kont, n.con); this.node = n.arg; return;
      case 'if':
        if (n.cond.atomic) { this.node = isTrue(this.atom(n.cond, env)) ? n.then : n.else; return; }
        this.kont = this.frame(K_IF, this.kont, n, env);
        this.node = n.cond;
        return;
      case 'let': {
        this.kont = this.frame(K_LETBODY, this.kont, n.body);
        this.kont = this.frame(K_DECS, this.kont, n.decs, 0, env, false);
        this.value = env;
        this.mode = RET;
        return;
      }
      case 'raise':
        this.kont = this.frame(K_RAISE, this.kont);
        this.node = n.exp;
        return;
      case 'handle':
        this.kont = this.frame(K_HANDLE, this.kont, n.rules, env);
        this.node = n.exp;
        return;
      default: throw new MLError('internal', 'machine: unknown expression ' + n.op);
    }
  }

  // Evaluate the remaining items of the tuple frame on top of the stack; leaves the machine in EVAL (waiting on a non-atomic
  // item, whose result comes back to the frame) or RET (tuple complete).
  tupleNext() {
    const f = this.kont;
    const items = f.a.items;
    const env = f.d;
    for (let i = f.b; i < items.length; i++) {
      if (items[i].atomic) { f.c[i] = this.atom(items[i], env); continue; }
      f.b = i;
      this.node = items[i];
      this.env = env;
      this.mode = EVAL;
      return;
    }
    this.kont = f.next;
    this.value = f.e ? f.e(f.c) : f.c;
    this.mode = RET;
  }

  ret() {
    const f = this.kont;
    const v = this.value;
    switch (f.k) {
      case K_HALT: this.state = 'done'; return;
      case K_APP1: {
        this.kont = f.next;
        const argNode = f.a;
        const env = f.b;
        if (argNode.atomic) { this.fn = v; this.value = this.atom(argNode, env); this.mode = APPLY; return; }
        this.kont = this.frame(K_APP2, this.kont, v);
        this.node = argNode;
        this.env = env;
        this.mode = EVAL;
        return;
      }
      case K_APP2: this.kont = f.next; this.fn = f.a; this.mode = APPLY; return;
      case K_TUPLE: f.c[f.b++] = v; this.tupleNext(); return;
      case K_CONAPP: this.kont = f.next; this.value = { tag: 'con', con: f.a, arg: v }; return;
      case K_IF: this.kont = f.next; this.node = isTrue(v) ? f.a.then : f.a.else; this.env = f.b; this.mode = EVAL; return;
      case K_RAISE: this.kont = f.next; this.mode = RAISE; return;
      case K_HANDLE: this.kont = f.next; return;
      case K_LETBODY: this.kont = f.next; this.node = f.a; this.env = v; this.mode = EVAL; return;
      case K_DECS: f.c = v; this.runDecs(f); return;
      case K_VAL: f.b++; f.c.push(v); this.contVal(f); return;
      case K_LOCALBODY: {
        // v: the environment after the head declarations
        const end = this.frame(K_LOCALEND, f.next, v, f.b, f.c);
        this.kont = this.frame(K_DECS, end, f.a.body, 0, v, f.b);
        this.value = v;
        return;
      }
      case K_STRUCT_END: this.kont = f.next; this.value = buildStruct(v, f.a); return;
      case K_APPLYF: {
        const fv = f.a.fcell ? f.a.fcell.value : lookupEnv(f.b, f.a.fkey);
        this.kont = f.next;
        this.node = fv.body;
        this.env = { name: 'S:' + fv.param, value: v, next: fv.env };
        this.mode = EVAL;
        return;
      }
      case K_THIN: this.kont = f.next; this.value = thinStruct(v, f.a.spec); return;
      case K_LETSTR: this.kont = f.next; this.node = f.a; this.env = v; this.mode = EVAL; return;
      case K_STRBIND: f.c.push(v); f.b++; this.contStr(f); return;
      case K_LOCALEND: {
        // v: the environment after the body; only the body's own frames escape the local declaration
        const headEnv = f.a;
        const outer = f.c;
        let result = outer;
        if (!f.b) { // local mode: copy the body's frames onto the outer environment, oldest first
          const mine = [];
          for (let e = v; e !== headEnv; e = e.next) mine.push(e);
          for (let i = mine.length - 1; i >= 0; i--) result = { name: mine[i].name, value: mine[i].value, next: result };
        }
        this.kont = f.next;
        this.value = result;
        return;
      }
      default: throw new MLError('internal', 'machine: unknown frame ' + f.k);
    }
  }

  apply() {
    const fn = this.fn;
    const arg = this.value;
    switch (fn.tag) {
      case 'closure': {
        const rules = fn.rules;
        for (let i = 0; i < rules.length; i++) {
          const e = matchPat(rules[i].pat, arg, fn.env);
          if (e !== FAIL) { this.node = rules[i].body; this.env = e; this.mode = EVAL; return; }
        }
        this.value = BUILTIN_EXN.Match;
        this.mode = RAISE;
        return;
      }
      case 'confn': this.value = { tag: 'con', con: fn.con, arg }; this.mode = RET; return;
      case 'excon': this.value = exnValue(fn, arg); this.mode = RET; return;
      case 'prim': this.value = fn.fn(arg, this); this.mode = RET; return;
      default: throw new MLError('internal', 'machine: not a function: ' + fn.tag);
    }
  }

  raise() {
    const exn = this.value;
    let k = this.kont;
    while (k.k !== K_HALT) {
      if (k.k === K_HANDLE) {
        for (const r of k.a) {
          const e = matchPat(r.pat, exn, k.b);
          if (e !== FAIL) { this.kont = k.next; this.node = r.body; this.env = e; this.mode = EVAL; return; }
        }
      }
      k = k.next;
    }
    this.kont = k;
    this.exn = exn;
    this.state = 'raised';
  }

  // ---- declarations ------------------------------------------------------------------------------------------------

  // `f` is a K_DECS frame (a: decs, b: next index, c: current env, d: top level?) that is on top of the stack.
  runDecs(f) {
    const decs = f.a;
    while (f.b < decs.length) {
      const d = decs[f.b++];
      switch (d.d) {
        case 'exception':
          for (const b of d.binds) {
            const excon = makeExcon(b.name, b.hasArg);
            const v = b.hasArg ? excon : exnValue(excon, undefined);
            if (f.d) d.cells.get(b.name).value = v;
            else f.c = { name: b.name, value: v, next: f.c };
          }
          break;
        case 'val':
          this.kont = this.frame(K_VAL, f, d, 0, [], f.c, f.d);
          this.contVal(this.kont);
          return;
        case 'structure':
          this.kont = this.frame(K_STRBIND, f, d, 0, [], f.c, f.d);
          this.contStr(this.kont);
          return;
        case 'functor': {
          const fv = { tag: 'functor', param: d.param, body: d.body, env: f.c };
          if (f.d) d.cells.get('F:' + d.name).value = fv;
          else f.c = { name: 'F:' + d.name, value: fv, next: f.c };
          break;
        }
        case 'open': {
          let st = d.cell ? d.cell.value : lookupEnv(f.c, d.key);
          for (let i = 1; i < d.path.length; i++) st = st.s.get(d.path[i]);
          for (const name of d.vals) f.c = { name, value: st.v.get(name), next: f.c };
          for (const name of d.strs) f.c = { name: 'S:' + name, value: st.s.get(name), next: f.c };
          break;
        }
        case 'local':
          this.kont = this.frame(K_LOCALBODY, f, d, f.d, f.c);
          this.kont = this.frame(K_DECS, this.kont, d.head, 0, f.c, false);
          this.value = f.c;
          this.mode = RET;
          return;
        default: throw new MLError('internal', 'machine: unknown declaration ' + d.d);
      }
    }
    this.kont = f.next;
    this.value = f.c;
    this.mode = RET;
  }

  // structure expressions: `node.s` says which. The result of evaluating one is a structure value.
  evalStr(n, env) {
    switch (n.s) {
      case 'path': {
        let st = n.cell ? n.cell.value : lookupEnv(env, n.key);
        for (let i = 1; i < n.path.length; i++) st = st.s.get(n.path[i]);
        this.value = st;
        this.mode = RET;
        return;
      }
      case 'struct':
        this.kont = this.frame(K_STRUCT_END, this.kont, n);
        this.kont = this.frame(K_DECS, this.kont, n.decs, 0, env, false);
        this.value = env;
        this.mode = RET;
        return;
      case 'apply':
        this.kont = this.frame(K_APPLYF, this.kont, n, env);
        this.node = n.arg;
        return;
      case 'thin':
        this.kont = this.frame(K_THIN, this.kont, n);
        this.node = n.str;
        return;
      case 'let':
        this.kont = this.frame(K_LETSTR, this.kont, n.body);
        this.kont = this.frame(K_DECS, this.kont, n.decs, 0, env, false);
        this.value = env;
        this.mode = RET;
        return;
      default: throw new MLError('internal', 'machine: unknown structure expression ' + n.s);
    }
  }

  // K_STRBIND frame: a: the structure declaration, b: next binding, c: the structure values so far, d: env at the start, e: top?
  contStr(f) {
    const d = f.a;
    if (f.b < d.binds.length) {
      this.node = d.binds[f.b].str;
      this.env = f.d;
      this.mode = EVAL;
      return;
    }
    let env = f.d;
    d.binds.forEach((b, i) => {
      if (f.e) d.cells.get('S:' + b.name).value = f.c[i];
      else env = { name: 'S:' + b.name, value: f.c[i], next: env };
    });
    this.kont = f.next;
    this.value = env;
    this.mode = RET;
  }

  // K_VAL frame: a: the val declaration, b: index of the next binding to evaluate, c: the values so far, d: env at the start,
  // e: top level?
  contVal(f) {
    const d = f.a;
    const env = f.d;
    while (f.b < d.binds.length) {
      const exp = d.binds[f.b].exp;
      if (exp.atomic) { f.c.push(this.atom(exp, env)); f.b++; continue; }
      this.node = exp;
      this.env = env;
      this.mode = EVAL;
      return;
    }
    this.finishVal(f);
  }

  finishVal(f) {
    const d = f.a;
    const base = f.d;
    const top = f.e;
    const vals = f.c;
    let env = base;
    if (top) {
      const assigns = [];
      for (let i = 0; i < d.binds.length; i++) {
        const m = matchPat(d.binds[i].pat, vals[i], null);
        if (m === FAIL) { this.value = BUILTIN_EXN.Bind; this.mode = RAISE; return; }
        for (let e = m; e; e = e.next) assigns.push(e);
      }
      for (const e of assigns) d.cells.get(e.name).value = e.value;
      for (const r of d.recs) d.cells.get(r.name).value = { tag: 'closure', rules: r.exp.rules, env: base };
    } else {
      for (let i = 0; i < d.binds.length; i++) {
        env = matchPat(d.binds[i].pat, vals[i], env);
        if (env === FAIL) { this.value = BUILTIN_EXN.Bind; this.mode = RAISE; return; }
      }
      if (d.recs.length) {
        // the closures see `base` plus the rec names only; the final environment gets copies of the rec frames on top
        let recEnv = base;
        const frames = d.recs.map((r) => ({ name: r.name, value: undefined, next: null }));
        for (const fr of frames) { fr.next = recEnv; recEnv = fr; }
        frames.forEach((fr, i) => { fr.value = { tag: 'closure', rules: d.recs[i].exp.rules, env: recEnv }; });
        for (const fr of frames) env = { name: fr.name, value: fr.value, next: env };
      }
    }
    this.kont = f.next;
    this.value = env;
    this.mode = RET;
  }
}

// Run an item to completion with no time limit (tests, small tools).
export function runToEnd(ir, globals, options) {
  const run = new ItemRun(ir, globals, options);
  while (run.step(1e9) === 'running');
  return run;
}
