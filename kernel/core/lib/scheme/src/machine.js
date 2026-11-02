// The evaluator: an explicit-continuation (CEK-style) machine.
//
// Registers: mode (EVAL: evaluate `node` in `env` | RET: deliver `val` to the
// continuation `k`), node, env, val, k. Continuations are heap-allocated linked
// Frames, so recursion depth is bounded by memory (and MAX_DEPTH), tail calls
// need no special handling (a tail call simply pushes no frame), and
// call/cc is just "remember the k pointer". run() executes until the program
// finishes or a time budget expires, so the host can interleave interrupts.
import {
  Pair, NIL, UNSPEC, UNASSIGNED, UNBOUND, DEFAULT, Closure, Primitive, MPrim, Continuation, Parameter,
  Promise_, Values, Condition, SchemeThrow, SchemeAbort, SchemeExit,
} from './types.js';
import { T, SIMPLE_MAX } from './nodes.js';
import { unboundVariable, unassignedVariable, wrongArgs, notApplicable } from './errors.js';
import { eqv } from './equality.js';

const EVAL = 0, RET = 1;

// frame tags
export const F_HALT = 0, F_IF = 1, F_SEQ = 2, F_ARG = 3, F_AND = 4, F_OR = 5, F_SETLOCAL = 6,
  F_SETGLOBAL = 7, F_DEFGLOBAL = 8, F_CASE = 9, F_CONSSTREAM = 10, F_JS = 11;

let MAX_DEPTH = 400000;
export function setMaxDepth(n) { MAX_DEPTH = n; }
export function getMaxDepth() { return MAX_DEPTH; }

export class Frame {
  constructor(t, next, a, b, c, i) {
    this.t = t; this.next = next; this.a = a; this.b = b; this.c = c; this.i = i;
    const d = next === null ? 0 : next.d + 1;
    if (d > MAX_DEPTH) throw new SchemeAbort('Aborting!: maximum recursion depth exceeded');
    this.d = d;
  }
}

export class Winder {
  constructor(before, after, next) {
    this.before = before; this.after = after; this.next = next;
    this.depth = next === null ? 1 : next.depth + 1;
  }
}
export class HandlerEntry { constructor(proc, next) { this.proc = proc; this.next = next; } }

class UncaughtError { constructor(obj) { this.obj = obj; } }

const NOT_SIMPLE = { notSimple: true };

export const STATUS = { DONE: 'done', YIELD: 'yield', INPUT: 'input', ERROR: 'error' };

function evalSimple(n, env) {
  switch (n.t) {
    case T.CONST: return n.a;
    case T.LOCAL0: {
      const v = env[n.a];
      if (v === UNASSIGNED) throw unassignedVariable(n.b);
      return v;
    }
    case T.LOCAL1: {
      const v = env[0][n.a];
      if (v === UNASSIGNED) throw unassignedVariable(n.b);
      return v;
    }
    case T.LOCALN: {
      let e = env;
      for (let d = n.a; d > 0; d--) e = e[0];
      const v = e[n.b];
      if (v === UNASSIGNED) throw unassignedVariable(n.c);
      return v;
    }
    case T.GLOBAL: {
      const v = n.a.v;
      if (v === UNBOUND) throw unboundVariable(n.a.name);
      if (v === UNASSIGNED) throw unassignedVariable(n.a.name);
      return v;
    }
    default: return env; // ENVREF
  }
}

// Evaluate a "leaf" expression without touching the continuation: a simple
// node, or a call to a plain primitive whose operands are all simple. Returns
// NOT_SIMPLE (having done nothing observable) if it can't be done inline.
function trySimple(n, env) {
  if (n.t <= SIMPLE_MAX) return evalSimple(n, env);
  if (n.t !== T.CALL || !n.b) return NOT_SIMPLE;
  const ops = n.a;
  const f = evalSimple(ops[0], env);
  if (!(f instanceof Primitive)) return NOT_SIMPLE;
  const nargs = ops.length - 1;
  if (nargs < f.min || (f.max >= 0 && nargs > f.max)) return NOT_SIMPLE;
  switch (nargs) {
    case 0: return f.fn();
    case 1: return f.fn(evalSimple(ops[1], env));
    case 2: return f.fn(evalSimple(ops[1], env), evalSimple(ops[2], env));
    case 3: return f.fn(evalSimple(ops[1], env), evalSimple(ops[2], env), evalSimple(ops[3], env));
    default: {
      const args = new Array(nargs);
      for (let i = 0; i < nargs; i++) args[i] = evalSimple(ops[i + 1], env);
      return f.fn.apply(null, args);
    }
  }
}

function windPath(from, to) {
  const steps = [], toRun = [];
  let a = from, b = to;
  while ((a ? a.depth : 0) > (b ? b.depth : 0)) { steps.push({ thunk: a.after, winders: a.next }); a = a.next; }
  while ((b ? b.depth : 0) > (a ? a.depth : 0)) { toRun.push({ thunk: b.before, winders: b.next }); b = b.next; }
  while (a !== b) {
    steps.push({ thunk: a.after, winders: a.next }); a = a.next;
    toRun.push({ thunk: b.before, winders: b.next }); b = b.next;
  }
  return steps.concat(toRun.reverse());
}

export class Machine {
  constructor(interp) {
    this.interp = interp;
    this.mode = RET;
    this.node = null;
    this.env = null;
    this.val = UNSPEC;
    this.k = null;
    this.winders = null;
    this.handlers = null;
    this.pause = null;          // 'input' while waiting for the host
    this.inputResolver = null;
    this.uncaught = undefined;  // the raised object when run() returns ERROR
    this.finished = true;
  }

  // Start evaluating `node` at top level.
  begin(node) {
    this.k = new Frame(F_HALT, null);
    this.node = node;
    this.env = null;
    this.mode = EVAL;
    this.winders = null;
    this.handlers = null;
    this.pause = null;
    this.finished = false;
    this.uncaught = undefined;
  }

  // Abandon whatever is running (after an abort/error/interrupt).
  abandon() {
    this.k = null; this.node = null; this.env = null; this.val = UNSPEC;
    this.winders = null; this.handlers = null; this.pause = null; this.finished = true;
  }

  // Deliver text to a machine paused for input.
  resume(text) {
    const r = this.inputResolver;
    this.inputResolver = null;
    this.pause = null;
    r(this, text); // sets val/mode, or pauses again if it needs more text
  }

  // Run until done / out of time / waiting for input / uncaught error.
  run(deadline) {
    let ticks = 0;
    for (;;) {
      try {
        for (;;) {
          if (this.pause !== null) return STATUS.INPUT;
          if ((++ticks & 2047) === 0 && performance.now() > deadline) return STATUS.YIELD;
          if (this.mode === EVAL) this.stepEval();
          else if (this.stepRet()) return STATUS.DONE;
        }
      } catch (e) {
        const r = this.handleError(e);
        if (r !== null) return r;
      }
    }
  }

  // Turn a JS exception from the step loop into a Scheme raise. Returns null if
  // a handler took over (keep running) or STATUS.ERROR if nothing handles it.
  // Loops because invoking a handler can itself fail (e.g. a non-procedure
  // handler); each failure consumes one handler, so it terminates.
  handleError(e) {
    for (;;) {
      if (e instanceof SchemeAbort || e instanceof SchemeExit) throw e;
      if (e instanceof UncaughtError) { this.uncaught = e.obj; return STATUS.ERROR; }
      let payload, continuable = false;
      if (e instanceof SchemeThrow) { payload = e.payload; continuable = e.continuable; }
      else if (e instanceof RangeError) {
        payload = new Condition('simple-error', 'Aborting!: maximum recursion depth exceeded', []);
      } else {
        if (typeof console !== 'undefined') console.error('[scheme] internal error', e);
        payload = new Condition('simple-error', 'Internal error: ' + (e && e.message ? e.message : String(e)), []);
      }
      try {
        this.doRaise(payload, continuable);
        return null;
      } catch (next) {
        e = next;
      }
    }
  }

  // --- raising ---------------------------------------------------------------------
  doRaise(obj, continuable) {
    const h = this.handlers;
    if (h === null) throw new UncaughtError(obj);
    this.k = new Frame(F_JS, this.k, continuable ? raiseContReturn : raiseReturn, { h, obj });
    this.handlers = h.next;
    this.applyProc([h.proc, obj]);
  }

  // --- continuations -----------------------------------------------------------------
  throwTo(cont, vals) {
    const v = vals.length === 1 ? vals[0] : new Values(vals);
    this.runRewind(windPath(this.winders, cont.winders), 0, cont, v);
  }
  runRewind(steps, i, cont, v) {
    if (i >= steps.length) {
      this.k = cont.k; this.winders = cont.winders; this.handlers = cont.handlers;
      this.val = v; this.mode = RET;
      return;
    }
    const st = steps[i];
    this.winders = st.winders;
    this.k = new Frame(F_JS, this.k, (m) => m.runRewind(steps, i + 1, cont, v), null);
    this.applyProc([st.thunk]);
  }

  // --- application -----------------------------------------------------------------------
  // vals[0] is the procedure, the rest are arguments. Takes ownership of `vals`.
  applyProc(vals) {
    const f = vals[0];
    if (f instanceof Closure) {
      const lam = f.lam;
      const nargs = vals.length - 1;
      if (nargs !== lam.nreq || lam.nopt !== 0 || lam.rest) this.adjustArgs(f, vals, nargs);
      vals[0] = f.env;
      for (let j = vals.length - 1; j < lam.size; j++) vals.push(UNASSIGNED);
      this.env = vals; this.node = lam.body; this.mode = EVAL;
      return;
    }
    if (f instanceof Primitive) {
      const nargs = vals.length - 1;
      if (nargs < f.min || (f.max >= 0 && nargs > f.max)) throw wrongArgs(f, nargs);
      let r;
      switch (nargs) {
        case 0: r = f.fn(); break;
        case 1: r = f.fn(vals[1]); break;
        case 2: r = f.fn(vals[1], vals[2]); break;
        case 3: r = f.fn(vals[1], vals[2], vals[3]); break;
        default: r = f.fn.apply(null, vals.slice(1));
      }
      this.val = r; this.mode = RET;
      return;
    }
    if (f instanceof MPrim) {
      const nargs = vals.length - 1;
      if (nargs < f.min || (f.max >= 0 && nargs > f.max)) throw wrongArgs(f, nargs);
      f.fn(this, vals);
      return;
    }
    if (f instanceof Continuation) { this.throwTo(f, vals.slice(1)); return; }
    if (f instanceof Parameter) {
      // one argument sets the value (an extension that interpreters written for this vocabulary use: (trace-apply-procedure #t))
      if (vals.length > 2) throw wrongArgs(f, vals.length - 1);
      if (vals.length === 2) { f.value = vals[1]; this.val = UNSPEC; this.mode = RET; return; }
      this.val = f.value; this.mode = RET;
      return;
    }
    throw notApplicable(f, vals.slice(1));
  }

  adjustArgs(f, vals, nargs) {
    const lam = f.lam;
    const maxPos = lam.nreq + lam.nopt;
    if (nargs < lam.nreq || (!lam.rest && nargs > maxPos)) throw wrongArgs(f, nargs);
    while (vals.length - 1 < maxPos) vals.push(DEFAULT);
    if (lam.rest) {
      let rest = NIL;
      for (let j = vals.length - 1; j > maxPos; j--) rest = new Pair(vals[j], rest);
      vals.length = maxPos + 1;
      vals.push(rest);
    }
  }

  // Evaluate operands ops[i..] of a CALL/LET node into vals, then finish.
  evalOperands(node, i, vals, env) {
    const ops = node.a, n = ops.length;
    for (; i < n; i++) {
      const o = ops[i];
      if (o.t <= SIMPLE_MAX) { vals[i] = evalSimple(o, env); continue; }
      if (o.t === T.CALL && o.b) {
        const v = trySimple(o, env);
        if (v !== NOT_SIMPLE) { vals[i] = v; continue; }
      }
      this.k = new Frame(F_ARG, this.k, node, env, vals, i);
      this.node = o; this.env = env; this.mode = EVAL;
      return;
    }
    if (node.t === T.CALL) { this.applyProc(vals); return; }
    // LET: vals = [env, init values...]; add unassigned slots for internal defines
    for (let j = node.b; j > 0; j--) vals.push(UNASSIGNED);
    this.env = vals; this.node = node.c; this.mode = EVAL;
  }

  // --- one EVAL step ----------------------------------------------------------------------------
  stepEval() {
    const node = this.node;
    switch (node.t) {
      case T.CONST: this.val = node.a; this.mode = RET; return;
      case T.LOCAL0: case T.LOCAL1: case T.LOCALN: case T.GLOBAL: case T.ENVREF:
        this.val = evalSimple(node, this.env); this.mode = RET; return;
      case T.IF: {
        const test = node.a;
        if (test.t <= SIMPLE_MAX || (test.t === T.CALL && test.b)) {
          const v = trySimple(test, this.env);
          if (v !== NOT_SIMPLE) { this.node = v !== false ? node.b : node.c; return; }
        }
        this.k = new Frame(F_IF, this.k, node, this.env);
        this.node = test;
        return;
      }
      case T.CALL: this.evalOperands(node, 0, new Array(node.a.length), this.env); return;
      case T.LET: {
        const vals = new Array(node.a.length);
        vals[0] = this.env;
        this.evalOperands(node, 1, vals, this.env);
        return;
      }
      case T.LAMBDA: this.val = new Closure(node.a, this.env); this.mode = RET; return;
      case T.SEQ:
        this.k = new Frame(F_SEQ, this.k, node, this.env, null, 1);
        this.node = node.a[0];
        return;
      case T.AND:
        this.k = new Frame(F_AND, this.k, node, this.env, null, 1);
        this.node = node.a[0];
        return;
      case T.OR:
        this.k = new Frame(F_OR, this.k, node, this.env, null, 1);
        this.node = node.a[0];
        return;
      case T.SETLOCAL:
        this.k = new Frame(F_SETLOCAL, this.k, node, this.env);
        this.node = node.c;
        return;
      case T.SETGLOBAL:
        this.k = new Frame(F_SETGLOBAL, this.k, node, this.env);
        this.node = node.c;
        return;
      case T.DEFGLOBAL:
        this.k = new Frame(F_DEFGLOBAL, this.k, node, this.env);
        this.node = node.c;
        return;
      case T.CASE:
        this.k = new Frame(F_CASE, this.k, node, this.env);
        this.node = node.a;
        return;
      case T.DELAY: this.val = new Promise_(node.a, this.env); this.mode = RET; return;
      case T.CONSSTREAM:
        this.k = new Frame(F_CONSSTREAM, this.k, node, this.env);
        this.node = node.a;
        return;
      default:
        throw new Error('internal: unknown node tag ' + node.t);
    }
  }

  // --- one RET step; returns true when the whole program has finished -------------------------------
  stepRet() {
    const f = this.k;
    this.k = f.next;
    switch (f.t) {
      case F_HALT:
        this.finished = true;
        return true;
      case F_IF:
        this.node = this.val !== false ? f.a.b : f.a.c;
        this.env = f.b; this.mode = EVAL;
        return false;
      case F_SEQ: {
        const nodes = f.a.a, i = f.i;
        this.env = f.b;
        if (i < nodes.length - 1) this.k = new Frame(F_SEQ, this.k, f.a, f.b, null, i + 1);
        this.node = nodes[i]; this.mode = EVAL;
        return false;
      }
      case F_ARG: {
        const vals = f.c.slice();
        vals[f.i] = this.val;
        this.evalOperands(f.a, f.i + 1, vals, f.b);
        return false;
      }
      case F_AND: case F_OR: {
        const isAnd = f.t === F_AND;
        const v = this.val;
        if (isAnd ? v === false : v !== false) return false; // short-circuit; val stays
        const nodes = f.a.a, i = f.i;
        this.env = f.b;
        if (i < nodes.length - 1) this.k = new Frame(f.t, this.k, f.a, f.b, null, i + 1);
        this.node = nodes[i]; this.mode = EVAL;
        return false;
      }
      case F_SETLOCAL: {
        const n = f.a;
        let e = f.b;
        for (let d = n.a; d > 0; d--) e = e[0];
        e[n.b] = this.val;
        this.val = UNSPEC;
        return false;
      }
      case F_SETGLOBAL: {
        const box = f.a.a;
        if (box.v === UNBOUND) throw unboundVariable(box.name);
        box.v = this.val;
        this.val = UNSPEC;
        return false;
      }
      case F_DEFGLOBAL:
        f.a.a.v = this.val;
        this.val = UNSPEC;
        return false;
      case F_CASE: {
        const key = this.val;
        this.env = f.b;
        for (const cl of f.a.b) {
          for (const d of cl.datums) {
            if (eqv(d, key)) { this.node = cl.body; this.mode = EVAL; return false; }
          }
        }
        if (f.a.c !== null) { this.node = f.a.c; this.mode = EVAL; } else this.val = UNSPEC;
        return false;
      }
      case F_CONSSTREAM:
        this.val = new Pair(this.val, new Promise_(f.a.b, f.b));
        return false;
      case F_JS:
        f.a(this, this.val, f.b);
        return false;
      default:
        throw new Error('internal: unknown frame tag ' + f.t);
    }
  }
}

// F_JS callbacks for raise
function raiseContReturn(m, val, data) { m.handlers = data.h; }
function raiseReturn(m, val, data) {
  // The handler returned from a non-continuable raise: signal a secondary
  // error in the handler's own dynamic context (the outer handlers).
  m.handlers = data.h.next;
  m.doRaise(new Condition('handler-returned', 'Exception handler returned from non-continuable raise', [data.obj]), false);
}
