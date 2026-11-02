// The Logo evaluation machine (LOGO.md 5.3). An explicit-continuation machine: evaluation state lives in a JS array of
// FRAMES on the heap, not on the JS call stack, so that
//   * recursion depth is limited by a configurable frame count, not by the JS stack (CSLS `student` and `pascal` recurse
//     deeper than a recursive JS evaluator survives),
//   * a tail call reuses its caller's frame (a loop written as tail recursion runs in constant space),
//   * a run can be interrupted between steps and resumed (`run(deadline)` returns 'running' and keeps its state),
//   * STOP, OUTPUT, THROW and errors are all non-local exits implemented by popping frames, never by JS exceptions
//     crossing evaluator frames.
//
// THE EVALUATION REQUEST. Every evaluation is requested by someone who knows whether it needs a value, and Logo's
// error messages depend on that (plm 3.1-3.2): "You don't say what to do with 3" when a value shows up where none is
// wanted, "foo didn't output to print" when none shows up where one is wanted. The request travels in three registers
// set before the machine goes into EVAL mode on a node:
//   rWant   NO (a command), VALUE (an operation's value is needed), or EITHER (.maybeoutput, RUNRESULT)
//   rBlame  the name of whoever wants the value, for "X didn't output to BLAME"
//   rTail   the procedure frame this evaluation is the last thing of (see tail calls), or null
// Whoever PRODUCES a value (a literal, a primitive, a returning procedure) checks it against the request it was given, so
// a consumer frame can always trust that a value it receives is wanted.
//
// TAIL CALLS. When the last instruction of a procedure body (or of an IF branch that is the last instruction, or the
// input of a tail OUTPUT) is a call to a user procedure, the caller's ProcFrame is popped before the callee's is pushed
// and the callee inherits the caller's request. That is only valid when the callee's request equals the caller's
// (`want === tail.want`): a command at the tail of a procedure that was itself called for a value is an error the caller's
// frame must still report, so it is not optimised away. Dynamic-scope consequence, as in the reference: the caller's local
// variables are gone by the time the callee runs.
//
// This file is the engine core. It knows nothing about any particular primitive except through the `prim` records the
// interpreter registers. Do not put language-library behaviour here.

import { Cell, NIL, LArray, isList, isWord, wordText, listFromArray, listToArray, nameKey } from './data.js';
import { N } from './treeify.js';
import { LogoError, CODE, err } from './errors.js';
import { showForm } from './printer.js';

// The value a CONST node delivers. A word or a list is immutable data, so the node's own value is handed out. An ARRAY
// literal in code (`make "a {0 0 0}`) is different: arrays are mutated in place (SETITEM), and the reference makes a new
// array every time such a literal is evaluated (a procedure that fills `{0 0 0}` gives a zeroed array on every call;
// tests/logo/seed/array-literal.lg, csls `poker`). Handing out the tree's own array would mutate the procedure's source
// and carry state from one call to the next. An array that is DATA (a member of a list that is merely passed around, never
// evaluated) is not a CONST node and stays shared, as in the reference. Call from the two places that read a CONST.
function constValue(v) {
  if (!(v instanceof LArray)) return v;
  return new LArray(v.items.map(constValue), v.origin);
}

// Evaluation requests.
export const NO = 0, VALUE = 1, EITHER = 2;
// Machine modes.
const EVAL = 0, RET = 1;
// Returned by a machine-op primitive that has arranged machine state itself (pushed frames / set the node) and will
// deliver its value later through the normal return path.
export const PENDING = Symbol('pending');

// Control-flow signals that are not Logo errors. Thrown out of Machine.run; the Job turns them into run states.
export class ByeSignal { constructor(code) { this.code = code; } }
export class ToplevelSignal {}

// ---------------------------------------------------------------------------------------------------------------------
// Procedures

// A user-defined procedure (TO, DEFINE, a procedure-text template). The body is kept as the list of its lines (each a
// Logo list), plus the raw text of each line for FULLTEXT, and is turned into nodes lazily on the first call.
export class Proc {
  constructor(name) {
    this.name = name;
    this.key = nameKey(name);
    this.required = [];      // [{key, name}]
    this.optional = [];      // [{key, name, def: list}]   def is the default-value expression as a list
    this.rest = null;        // {key, name} | null
    this.min = 0; this.def = 0; this.max = 0;   // max -1 = unlimited
    this.lines = [];         // body lines, each a list datum
    this.rawLines = null;    // raw text of the TO line, each body line and END, or null (DEFINE)
    this.isMacro = false;
    this.nodes = null;       // cached treeified body, flat, each top-level node carrying .line
    this.nodesEpoch = -1;
    this.formalsText = null; // the title line's formals as typed, for FULLTEXT / PO
    this.owner = null;       // which cell defined it (decision 15), or null
    this.dialect = 'logo';   // the surface syntax it was written in: 'logo' | 'tpn' (LOGO.md 4.4); set by the Job that defines it
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Frames. A frame is popped off the stack when a value is returned to it, and then has resume(m, val) called. A frame
// that needs the value of something else pushes itself back first. Frames that hold machine state (variables, template
// slots, repeat counters) implement unwind(m) so a non-local exit can restore it.

// Evaluates the inputs of a call, left to right, then applies the procedure.
class ArgFrame {
  constructor(node, proc, want, blame, tail) {
    this.node = node; this.proc = proc; this.want = want; this.blame = blame; this.tail = tail;
    this.i = 0; this.vals = [];
  }
  resume(m, val) { this.vals.push(val); this.next(m); }
  next(m) {
    const args = this.node.args;
    while (this.i < args.length) {
      const a = args[this.i];
      if (a.t === N.CONST) { this.vals.push(constValue(a.v)); this.i++; }
      else if (a.t === N.VAR) { this.vals.push(m.lookupVar(a.key, a.name)); this.i++; }
      else {
        this.i++;
        m.stack.push(this);
        m.node = a; m.mode = EVAL; m.rWant = VALUE; m.rBlame = this.node.name; m.rTail = null;
        return;
      }
    }
    m.apply(this.proc, this.node, this.vals, this.want, this.blame, this.tail);
  }
}

// A sequence of instruction nodes. The LAST instruction is evaluated without the frame on the stack (it is in tail
// position and nothing is left to do after it), under the sequence's own request; the earlier ones are commands.
// `procFrame` is set for a procedure's body so the current line can be recorded for error messages.
class SeqFrame {
  constructor(nodes, want, blame, tail, procFrame) {
    this.nodes = nodes; this.want = want; this.blame = blame; this.tail = tail; this.procFrame = procFrame; this.i = 0;
  }
  resume(m, val) { this.advance(m); }
  advance(m) {
    const nodes = this.nodes, i = this.i, node = nodes[i];
    if (this.procFrame !== null && node.line) this.procFrame.line = node.line;
    if (i < nodes.length - 1) {
      this.i = i + 1;
      m.stack.push(this);
      m.rWant = NO; m.rBlame = ''; m.rTail = null;
    } else {
      m.rWant = this.want; m.rBlame = this.blame; m.rTail = this.tail;
    }
    m.node = node; m.mode = EVAL;
  }
}

// One activation of a user procedure.
class ProcFrame {
  constructor(proc, want, blame, prevScope) {
    this.proc = proc; this.want = want; this.blame = blame; this.prevScope = prevScope;
    this.scope = { names: [] };   // keys of the variables this activation bound (inputs, LOCALs)
    this.line = null;             // the body line being run, as a list, for error messages
    this.test = undefined;        // this activation's TEST result, if it has run TEST
  }
  resume(m, val) { m.exitProc(this, val); }
  // Pops this activation's variable bindings and restores the enclosing scope. Called on normal exit, on a tail call
  // that replaces the frame, and by unwind(). Safe to call once only.
  release(m) {
    const names = this.scope.names;
    for (let k = names.length - 1; k >= 0; k--) m.vars.get(names[k]).pop();
    m.scope = this.prevScope;
  }
  unwind(m) { this.release(m); }
}

// Evaluates the default expressions of optional inputs the caller did not supply (manual, TO), in order, in the new
// procedure's scope, then starts the body.
class InitFrame {
  constructor(frame, proc, k) { this.frame = frame; this.proc = proc; this.k = k; }
  resume(m, val) {
    const opt = this.proc.optional[this.k - this.proc.required.length];
    m.bindVar(opt.key, val);
    this.k++;
    this.go(m);
  }
  go(m) {
    const proc = this.proc, nreq = proc.required.length;
    if (this.k - nreq < proc.optional.length) {
      const opt = proc.optional[this.k - nreq];
      m.stack.push(this);
      m.runList(opt.def, VALUE, 'to', null, 'to');
      return;
    }
    m.startBody(this.frame);
  }
}

// OUTPUT outside tail position (inside REPEAT, FOREACH ...): receives the value and leaves the procedure.
class OutputFrame {
  constructor(target) { this.target = target; }
  resume(m, val) { m.unwindToProc(this.target, val); }
}

class CatchFrame {
  constructor(tagKey, want, blame) { this.tagKey = tagKey; this.want = want; this.blame = blame; }
  resume(m, val) { m.val = val; m.mode = RET; }   // normal completion: the body already honoured the request
}

// Delimits a RUNRESULT: OUTPUT and STOP may not cross it (error 38, manual: "Can't use OUTPUT or STOP inside RUNRESULT").
class RunResultFrame {
  constructor(want, blame) { this.want = want; this.blame = blame; }
  resume(m, val) { m.complete(val === undefined ? NIL : new Cell(val, NIL), this.want, this.blame, 'runresult'); }
}

class RepeatFrame {
  constructor(count, nodes, list, saved) { this.count = count; this.nodes = nodes; this.i = 0; this.saved = saved; }
  resume(m, val) { this.next(m); }
  next(m) {
    if (this.count >= 0 && this.i >= this.count) { m.repcount = this.saved; m.val = undefined; m.mode = RET; return; }
    this.i++;
    m.repcount = this.i;
    m.stack.push(this);
    const sf = new SeqFrame(this.nodes, NO, '', null, null);
    if (this.nodes.length === 0) { m.mode = RET; m.val = undefined; return; }
    sf.advance(m);
  }
  unwind(m) { m.repcount = this.saved; }
}

// A template activation (explicit-slot or named-slot): holds the previous slot register and, for named-slot, the
// variables the template bound.
class TemplateFrame {
  constructor(savedSlots, scope, prevScope) { this.savedSlots = savedSlots; this.scope = scope; this.prevScope = prevScope; }
  resume(m, val) { this.release(m); m.val = val; m.mode = RET; }
  release(m) {
    m.slots = this.savedSlots;
    if (this.scope) {
      const names = this.scope.names;
      for (let k = names.length - 1; k >= 0; k--) m.vars.get(names[k]).pop();
      m.scope = this.prevScope;
    }
  }
  unwind(m) { this.release(m); }
}

// A frame whose behaviour is a closure: used by the iteration primitives (MAP, FOREACH, WHILE ...), which are written as
// small state machines over `m.applyTemplate`. fn(m, val) must leave the machine ready for the next step, either by
// pushing this frame again and starting something, or by calling m.complete(...).
// Milliseconds on a monotonic clock where there is one (every browser and Node), else the wall clock. A job's deadline is a
// value of this clock; Interpreter and Job use the same function.
export const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class CBFrame {
  constructor(fn, unwind) { this.fn = fn; this.unwindFn = unwind || null; }
  resume(m, val) { this.fn(m, val); }
  unwind(m) { if (this.unwindFn) this.unwindFn(m); }
}

// ---------------------------------------------------------------------------------------------------------------------

const UNBOUND = Symbol('unbound');

export class Machine {
  constructor(interp, opts = {}) {
    this.interp = interp;
    this.stack = [];
    this.mode = RET;
    this.node = null;
    this.val = undefined;
    this.rWant = NO; this.rBlame = ''; this.rTail = null;
    this.vars = new Map();        // key -> array of cells {v}; the bottom cell of a key that has one is the global
    this.scope = null;            // innermost procedure / named-slot template scope, or null at top level
    this.repcount = -1;
    this.slots = null;            // {args, index} of the innermost active template, or null
    this.testTop = undefined;     // TEST result at top level
    this.lastError = NIL;         // what ERROR outputs next, then it is cleared
    this.inErract = false;        // an ERRACT handler is running (see startErract)
    this.maxFrames = opts.maxFrames || 400000;
    this.cancelled = false;
    this.steps = 0;
  }

  // ---- variables --------------------------------------------------------------------------------------------------

  // The value of variable `key`; `name` is only for the error message. Dynamic scope: the newest binding of the name
  // anywhere up the chain of active procedures, falling back to the global.
  lookupVar(key, name) {
    const st = this.vars.get(key);
    if (st !== undefined && st.length > 0) {
      const v = st[st.length - 1].v;
      if (v !== UNBOUND) return v;
    }
    throw err.noValue(name);
  }

  // Is there a visible binding with a value? (NAMEP, THING-without-error callers)
  hasVar(key) {
    const st = this.vars.get(key);
    return st !== undefined && st.length > 0 && st[st.length - 1].v !== UNBOUND;
  }

  // Creates a new binding of `key` in the current scope (an input, LOCAL).
  bindVar(key, value) {
    let st = this.vars.get(key);
    if (st === undefined) { st = []; this.vars.set(key, st); }
    st.push({ v: value });
    this.scope.names.push(key);
  }

  // MAKE: assign the innermost visible binding, else create a global.
  setVar(key, value) {
    let st = this.vars.get(key);
    if (st === undefined) { st = []; this.vars.set(key, st); }
    if (st.length === 0) st.push({ v: value });
    else st[st.length - 1].v = value;
  }

  // LOCAL: a new binding with no value yet.
  declareLocal(key) {
    if (this.scope === null) throw err.onlyInProc('local');
    this.bindVar(key, UNBOUND);
  }

  // ---- TEST state --------------------------------------------------------------------------------------------------

  setTest(v) {
    for (let k = this.stack.length - 1; k >= 0; k--) {
      const f = this.stack[k];
      if (f instanceof ProcFrame) { f.test = v; return; }
    }
    this.testTop = v;
  }

  getTest() {
    for (let k = this.stack.length - 1; k >= 0; k--) {
      const f = this.stack[k];
      if (f instanceof ProcFrame && f.test !== undefined) return f.test;
    }
    return this.testTop;
  }

  // ---- running ----------------------------------------------------------------------------------------------------

  // Starts evaluating a list of instruction nodes as a top-level line (a command sequence). The stack must be empty.
  begin(nodes) {
    this.stack.length = 0;
    this.val = undefined;
    const sf = new SeqFrame(nodes, NO, '', null, null);
    if (nodes.length === 0) { this.mode = RET; return; }
    sf.advance(this);
  }

  // Runs until the line finishes ('done'), or `deadline` (a performance.now() value) passes or cancelled is set
  // ('running'; call again to continue). Throws LogoError for an uncaught Logo error, ByeSignal / ToplevelSignal for
  // BYE / THROW "TOPLEVEL. After any throw the machine is in an undefined state: call abandon() before reusing it.
  run(deadline) {
    let n = 0;
    let pending = null;      // a Logo error raised and not yet offered to a CATCH
    let unhandled = null;    // a Logo error no CATCH took
    for (;;) {
      try {
        // Offering an error to a CATCH can itself raise one (the catching CATCH may have been asked for a value), so
        // it happens inside the try: a second error goes round the loop and is offered in turn.
        if (pending !== null) {
          const e = pending;
          pending = null;
          if (!this.handleError(e)) { unhandled = e; break; }
        }
        for (;;) {
          if (this.mode === EVAL) this.evalNode();
          else {
            const f = this.stack.pop();
            if (f === undefined) return 'done';
            f.resume(this, this.val);
          }
          if ((++n & 511) === 0 && (this.cancelled || now() > deadline)) return 'running';
        }
      } catch (e) {
        if (e instanceof LogoError) { pending = e; continue; }
        throw e;
      }
    }
    throw unhandled;
  }

  // Drops every frame, restoring the machine state each one held (variable bindings, template slots, repeat counter), so
  // an interrupted or failed run leaves the global environment intact and the machine reusable.
  abandon() {
    while (this.stack.length > 0) {
      const f = this.stack.pop();
      if (f.unwind) f.unwind(this);
    }
    this.mode = RET; this.val = undefined; this.node = null;
    this.scope = null; this.slots = null; this.repcount = -1;
    this.inErract = false;
  }

  // ---- evaluation ---------------------------------------------------------------------------------------------------

  evalNode() {
    const n = this.node;
    switch (n.t) {
      case N.CONST: this.deliver(constValue(n.v)); return;
      case N.VAR: this.deliver(this.lookupVar(n.key, n.name)); return;
      case N.CALL: this.beginCall(n); return;
      default: throw n.error;
    }
  }

  // A value that is already known (a literal, a variable) satisfies the request unless the request is for no value.
  deliver(v) {
    if (this.rWant === NO) throw err.noPlan(showForm(v));
    this.val = v; this.mode = RET;
  }

  // Delivers the result of a primitive or machine operation `who` against the request (want, blame).
  complete(v, want, blame, who) {
    if (v === undefined) {
      if (want === VALUE) throw err.notOutput(who, blame);
    } else if (want === NO) throw err.noPlan(showForm(v));
    this.val = v; this.mode = RET;
  }

  beginCall(n) {
    if (n.err !== null) throw n.err;
    if (n.short) throw err.tooFew(n.name);
    const proc = this.interp.procs.get(n.key);
    if (proc === undefined) {
      // The reference evaluates a bare word that is not a procedure but names a variable: after `make "yy 6`, `show yy`
      // prints 6 (recorded in tests/logo/seed/bare-variable.lg). A procedure of the same name still wins (checked first
      // above), and a name that is neither stays the usual "I don't know how to". Used as a command it gives the usual
      // "You don't say what to do with 6" through deliver. Do not extend this to names that take inputs: an unknown name
      // never has any.
      if (n.args.length === 0 && this.hasVar(n.key)) { this.deliver(this.lookupVar(n.key, n.name)); return; }
      throw err.unknownProc(n.shown || n.name);
    }
    if (proc.special !== undefined && proc.special !== null) { this.beginSpecial(n, proc); return; }
    if (n.args.length === 0) { this.apply(proc, n, [], this.rWant, this.rBlame, this.rTail); return; }
    new ArgFrame(n, proc, this.rWant, this.rBlame, this.rTail).next(this);
  }

  // OUTPUT and .MAYBEOUTPUT are special forms: their input is evaluated in tail position when the OUTPUT is itself the
  // procedure's tail, which is what lets `output f :n-1` recurse without growing the stack.
  beginSpecial(n, proc) {
    if (n.args.length < 1) throw err.tooFew(n.name);
    const fi = this.nearestProc(n.name.toLowerCase());
    if (fi < 0) throw err.onlyInProc(n.name.toLowerCase());
    const F = this.stack[fi];
    const either = proc.special === 'maybeoutput';
    if (this.rTail === F && this.stack[this.stack.length - 1] === F) {
      this.node = n.args[0]; this.mode = EVAL;
      this.rWant = either ? EITHER : F.want; this.rBlame = F.blame || 'output'; this.rTail = F;
      return;
    }
    this.stack.push(new OutputFrame(F));
    this.node = n.args[0]; this.mode = EVAL;
    this.rWant = either ? EITHER : VALUE; this.rBlame = n.name; this.rTail = null;
  }

  // Applies a procedure or primitive to evaluated inputs under a request. `node` is the call node or null.
  apply(proc, node, vals, want, blame, tail) {
    if (proc.fn !== undefined) {
      this.complete(proc.fn(vals, this), want, blame, proc.name);
      return;
    }
    if (proc.op !== undefined) {
      const r = proc.op(this, vals, want, blame, tail);
      if (r !== PENDING) this.complete(r, want, blame, proc.name);
      return;
    }
    this.callUser(proc, vals, want, blame, tail);
  }

  callUser(proc, vals, want, blame, tail) {
    if (proc.isMacro) { this.callMacro(proc, vals, want, blame); return; }
    this.callProc(proc, vals, want, blame, tail);
  }

  // The call proper (callUser minus the macro check, which would otherwise recurse into itself).
  callProc(proc, vals, want, blame, tail) {
    let prevScope = this.scope;
    let inherited = null;
    if (tail !== null && this.stack[this.stack.length - 1] === tail && want === tail.want) {
      // Tail call: the caller's frame is done once the callee returns, so drop the FRAME now. Its variable bindings are
      // another matter: the reference keeps them visible to the callee (dynamic scope: `to f1 local "x make "x 5 f2 end`
      // lets f2 see x even though f2 is f1's last instruction, 11.5 item 3), so only the bindings the callee shadows with
      // its own inputs are dropped (nothing can ever see those again, which is what keeps `loop :n-1` constant-space);
      // the rest move to the callee's scope and go when it returns.
      this.stack.pop();
      const shadowed = new Set();
      for (const r of proc.required) shadowed.add(r.key);
      for (const o of proc.optional) shadowed.add(o.key);
      if (proc.rest !== null) shadowed.add(proc.rest.key);
      const names = tail.scope.names;
      inherited = [];
      for (let k = names.length - 1; k >= 0; k--) {
        if (shadowed.has(names[k])) this.vars.get(names[k]).pop(); else inherited.push(names[k]);
      }
      inherited.reverse();
      prevScope = tail.prevScope;
      blame = tail.blame;
    }
    if (this.stack.length > this.maxFrames) throw err.stackOverflow();
    const frame = new ProcFrame(proc, want, blame, prevScope);
    if (inherited !== null) frame.scope.names = inherited;
    this.scope = frame.scope;
    const req = proc.required, nreq = req.length, opt = proc.optional;
    for (let k = 0; k < nreq; k++) this.bindVar(req[k].key, vals[k]);
    for (let k = 0; k < opt.length; k++) if (nreq + k < vals.length) this.bindVar(opt[k].key, vals[nreq + k]);
    if (proc.rest !== null) this.bindVar(proc.rest.key, listFromArray(vals.slice(nreq + opt.length)));
    this.stack.push(frame);
    const supplied = vals.length;
    if (supplied < nreq + opt.length) {
      // Optional inputs the caller left out: evaluate their defaults in this scope, left to right.
      new InitFrame(frame, proc, Math.max(supplied, nreq)).go(this);
      return;
    }
    this.startBody(frame);
  }

  startBody(frame) {
    const nodes = this.interp.bodyNodes(frame.proc);
    if (nodes.length === 0) { this.val = undefined; this.mode = RET; return; }
    new SeqFrame(nodes, NO, '', frame, frame).advance(this);
  }

  // A procedure finished (fell off its end, STOPped, or OUTPUT a value): pop its bindings and hand `val` to whoever
  // called it, after checking it against what they asked for.
  exitProc(F, val) {
    F.release(this);
    if (val === undefined) {
      if (F.want === VALUE) throw err.notOutput(F.proc.name, F.blame);
    } else if (F.want === NO) throw err.noPlan(showForm(val));
    this.val = val; this.mode = RET;
  }

  // ---- macros ------------------------------------------------------------------------------------------------------

  // A macro is a procedure whose OUTPUT is a list of instructions that is then run in the caller's context, as if it had
  // been written where the call is (manual, MACROS). Its own request is "must output a list".
  callMacro(proc, vals, want, blame) {
    this.stack.push(new CBFrame((m, expansion) => {
      if (expansion === undefined || !isList(expansion)) throw err.macroReturned(expansion === undefined ? nothing : showForm(expansion));
      m.runList(expansion, want, blame, null, proc.name);
    }));
    // EITHER, not VALUE: a macro that returns nothing is the "Macro returned ... instead of a list" error (29) rather
    // than the generic "didn't output" one.
    this.callProc(proc, vals, EITHER, proc.name, null);
  }

  // ---- non-local exits --------------------------------------------------------------------------------------------

  // Index in the stack of the innermost procedure frame, or -1 if there is none. OUTPUT / STOP cannot cross a RUNRESULT.
  nearestProc(who) {
    for (let k = this.stack.length - 1; k >= 0; k--) {
      const f = this.stack[k];
      if (f instanceof ProcFrame) return k;
      if (f instanceof RunResultFrame) throw new LogoError(CODE.NO_OUTPUT_IN_RUNRESULT, "Can't use OUTPUT or STOP inside RUNRESULT");
    }
    return -1;
  }

  // Leaves the procedure frame F (somewhere in the stack) with `val` as its output, or no output when undefined.
  unwindToProc(F, val) {
    for (;;) {
      const g = this.stack.pop();
      if (g === F) break;
      if (g.unwind) g.unwind(this);
    }
    this.exitProc(F, val);
  }

  // THROW. `tagKey` is the lowercased tag. Returns normally having delivered through the catching frame's request.
  doThrow(tagKey, value) {
    for (let k = this.stack.length - 1; k >= 0; k--) {
      const f = this.stack[k];
      if (f instanceof CatchFrame && f.tagKey === tagKey) { this.unwindToCatch(k, value); return; }
    }
    if (tagKey === 'toplevel') throw new ToplevelSignal();
    if (tagKey === 'system') throw new ByeSignal(0);
    throw err.noCatch(tagKey);
  }

  unwindToCatch(index, value) {
    const f = this.stack[index];
    while (this.stack.length > index + 1) { const g = this.stack.pop(); if (g.unwind) g.unwind(this); }
    this.stack.pop();
    this.complete(value, f.want, f.blame, 'catch');
  }

  // An error was raised. Fill in where it happened, then hand it to the innermost CATCH "ERROR if there is one, else
  // rethrow it to the caller of run().
  // Returns true when a CATCH "ERROR took it, false when the error is uncaught (the caller of run() reports it).
  handleError(e) {
    if (e.proc === null && !e.located) {
      for (let k = this.stack.length - 1; k >= 0; k--) {
        const f = this.stack[k];
        if (f instanceof ProcFrame) { e.proc = f.proc.name; e.line = f.line; break; }
      }
    }
    for (let k = this.stack.length - 1; k >= 0; k--) {
      const f = this.stack[k];
      if (f instanceof CatchFrame && f.tagKey === 'error') {
        this.lastError = errorList(e);
        this.unwindToCatch(k, undefined);
        return true;
      }
    }
    return this.startErract(e);
  }

  // ERRACT (LOGO.md 14.6, checked against the reference 2026-10-23). An error no CATCH took runs the instruction list in
  // the variable ERRACT, if there is a non-empty one, ON TOP of the failing frames (so it sees the failing procedure's
  // variables), with ERROR giving the details. When it ends the error carries on as usual: the message is reported and the
  // line abandoned -- except that a handler which read the error with ERROR has consumed it, and then the message is not
  // printed (e.quiet). A CATCH "ERROR still wins and ERRACT does not run for what it caught. An error inside the handler
  // is not handed to ERRACT again. STOP and OUTPUT inside the handler are not specified (the reference's result is odd);
  // they are not supported. Returns true when a handler was started.
  startErract(e) {
    if (e.erractRan || this.inErract || !this.hasVar('erract')) return false;
    const act = this.lookupVar('erract', 'erract');
    if (!isList(act) || act === NIL) return false;
    this.inErract = true;
    e.erractRan = true;      // the rethrow below must not start the handler again
    this.lastError = errorList(e);
    this.stack.push(new CBFrame((m) => {
      m.inErract = false;
      e.quiet = m.lastError === NIL;
      m.lastError = NIL;
      throw e;
    }));
    this.runList(act, NO, '', null, 'erract');
    return true;
  }

  // ---- running lists, templates -------------------------------------------------------------------------------------

  // Runs `list` (an instruction list; a word is parsed into one) under the request (want, blame, tail). `who` names the
  // primitive for the empty-list "didn't output" message.
  runList(list, want, blame, tail, who) {
    if (isWord(list)) list = this.interp.parseWord(list);
    if (!isList(list)) throw err.badType(who, showForm(list));
    const nodes = this.interp.getTree(list);
    if (nodes.length === 0) { this.complete(undefined, want, blame, who); return; }
    new SeqFrame(nodes, want, blame, tail, null).advance(this);
  }

  // Starts REPEAT / FOREVER-style iteration of `list` (count < 0: forever).
  repeatList(count, list) {
    if (isWord(list)) list = this.interp.parseWord(list);
    if (!isList(list)) throw err.badType('repeat', showForm(list));
    const nodes = this.interp.getTree(list);
    new RepeatFrame(count, nodes, list, this.repcount).next(this);
  }

  // Applies a TEMPLATE (LOGO.md 4.1: explicit-slot, named-procedure, named-slot, procedure-text) to `args` under a
  // request. `who` is the iteration primitive's name, used for messages and for the anonymous procedure a procedure-text
  // template becomes. `index` is the value of # (position in the data), or undefined; `rest` a function giving ?REST;
  // `named` an object of extra named slots (TRANSFER's ?IN and ?OUT).
  applyTemplate(tpl, args, want, blame, who, index, rest, named) {
    if (isWord(tpl)) {
      const key = nameKey(wordText(tpl));
      const proc = this.interp.procs.get(key);
      if (proc === undefined) {
        // Same fallback as beginCall: a bare name that is a variable evaluates to it (`apply "yy []`), taking no inputs.
        if (args.length === 0 && this.hasVar(key)) { this.complete(this.lookupVar(key, wordText(tpl)), want, blame, who); return; }
        throw err.unknownProc(wordText(tpl));
      }
      if (args.length < proc.min) throw err.tooFew(proc.name);
      if (proc.max >= 0 && args.length > proc.max) throw err.tooMany(proc.name);
      this.apply(proc, null, args, want, blame, null);
      return;
    }
    if (!isList(tpl)) throw err.applyBad(showForm(tpl));
    if (tpl === NIL) { this.complete(undefined, want, blame, who); return; }
    if (isList(tpl.first)) {
      // Lambda or procedure text. Procedure text: at least two members, all of them lists.
      let allLists = tpl.rest !== NIL;
      for (let c = tpl.rest; c instanceof Cell; c = c.rest) if (!isList(c.first)) { allLists = false; break; }
      if (allLists) {
        const proc = this.interp.procedureFromText(tpl, who);
        this.callUser(proc, args, want, blame, null);
        return;
      }
      // Named-slot: bind the names to the data in a fresh scope; the body is the rest of the template.
      const names = listToArray(tpl.first);
      if (names.length !== args.length) throw names.length > args.length ? err.tooFew(who) : err.tooMany(who);
      const frame = new TemplateFrame(this.slots, { names: [] }, this.scope);
      this.scope = frame.scope;
      for (let k = 0; k < names.length; k++) this.bindVar(nameKey(wordText(names[k])), args[k]);
      this.stack.push(frame);
      this.runList(tpl.rest, want, blame, null, who);
      return;
    }
    // Explicit-slot: ? / ?1 / # / ?REST read the slot register.
    const frame = new TemplateFrame(this.slots, null, null);
    this.slots = { args, index, rest, named };
    this.stack.push(frame);
    this.runList(tpl, want, blame, null, who);
  }

  // Runs `list` as an EXPRESSION that must produce true or false, then calls k(boolean). k must leave the machine ready
  // (typically by calling complete or pushing further frames).
  evalTf(x, who, k) {
    if (isWord(x)) { k(tfOf(x, who)); return; }
    this.stack.push(new CBFrame((m, v) => k(tfOf(v, who))));
    this.runList(x, VALUE, who, null, who);
  }
}

// Converts a TRUE / FALSE word (any case) to a boolean, else the "doesn't like" error naming the primitive.
export function tfOf(x, who) {
  if (isWord(x)) {
    const t = wordText(x).toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
  }
  throw err.badType(who, showForm(x));
}

// What ERROR outputs: [code message procname line]; procname and line are [] at top level.
export function errorList(e) {
  const procName = e.proc === null ? NIL : e.proc;
  const line = e.line === null ? NIL : e.line;
  return listFromArray([e.code, e.message, procName, line]);
}

// Frames the control primitives (control.js) push themselves.
export { CatchFrame, RunResultFrame, ProcFrame, TemplateFrame };
