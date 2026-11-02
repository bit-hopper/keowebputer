// Macro expansion + analysis: s-expression -> Node tree with lexical addressing.
//
// Derived forms (cond, do, guard, ...) are written as native macros that
// build datums containing SpecialForm objects and primitive objects directly
// in head position, so a user binding or redefinition of `if`, `cons`, `list`
// etc. can never change what a derived form means.
import {
  Pair, NIL, UNSPEC, UNASSIGNED, Sym, Primitive, Record, RecordType, LexicalEnv, intern, gensym, stripSym,
  list, arrayToList, listToArray,
} from './types.js';
import { Node, T, LamInfo, SIMPLE_MAX } from './nodes.js';
import { syntaxError, wrongType } from './errors.js';
import { SyntaxRules, stripForm } from './syntax-rules.js';

export class SpecialForm { constructor(name, fn) { this.name = name; this.fn = fn; } }
export class NativeMacro {
  constructor(name, fn) { this.name = name; this.fn = fn; }
  expand(form, scope, c) { return this.fn(form, scope, c); }
}

class Scope {
  constructor(parent, names, hasFrame = true) {
    this.parent = parent;
    this.names = names;
    this.hasFrame = hasFrame;
    this.macros = null;
  }
}

const ENVREF = new Node(T.ENVREF);
const UNSPEC_NODE = new Node(T.CONST, UNSPEC);

const isKw = (x, name) => x instanceof Sym && stripSym(x).name === name;
const cons = (a, b) => new Pair(a, b);

function toArr(x, form) {
  const a = listToArray(x);
  if (a === null) throw syntaxError('Ill-formed special form', stripForm(form));
  return a;
}
function bad(form) { return syntaxError('Ill-formed special form', stripForm(form)); }

// Replace aliases by base symbols throughout a datum (for `quote`).
export function strip(x) {
  if (x instanceof Sym) return stripSym(x);
  if (x instanceof Pair) {
    const items = [];
    let p = x, changed = false;
    while (p instanceof Pair) { const a = strip(p.car); if (a !== p.car) changed = true; items.push(a); p = p.cdr; }
    const tail = strip(p);
    if (tail !== p) changed = true;
    return changed ? arrayToList(items, tail) : x;
  }
  if (Array.isArray(x)) {
    let changed = false;
    const r = x.map((e) => { const s = strip(e); if (s !== e) changed = true; return s; });
    return changed ? r : x;
  }
  return x;
}

export function frameScope(scope) {
  let s = scope;
  while (s && !s.hasFrame) s = s.parent;
  return s;
}
function depthBetween(from, target) {
  let d = 0;
  for (let s = from; s !== target; s = s.parent) {
    if (!s) throw new Error('internal: scope target not found');
    if (s.hasFrame) d++;
  }
  return d;
}

export const SF = {};
function defSF(name, fn) { SF[name] = new SpecialForm(name, fn); return SF[name]; }

export class Compiler {
  constructor(interp) { this.interp = interp; }

  prim(name) {
    const p = this.interp.primTable.get(name);
    if (!p) throw new Error('internal: missing primitive ' + name);
    return p;
  }

  // --- name resolution -------------------------------------------------------
  resolve(sym, scope) {
    for (let s = scope; s; s = s.parent) {
      if (s.macros) { const m = s.macros.get(sym); if (m) return { kind: 'macro', macro: m }; }
      const i = s.names.indexOf(sym);
      if (i >= 0) return { kind: 'local', scope: s, index: i + 1 };
    }
    if (sym.base) return this.resolve(sym.base, sym.env);
    const sf = this.interp.specials.get(sym);
    if (sf) return { kind: 'special', sf };
    const m = this.interp.macros.get(sym);
    if (m) return { kind: 'macro', macro: m };
    return { kind: 'global', sym };
  }

  specialOf(head, scope) {
    if (head instanceof SpecialForm) return head;
    if (head instanceof Sym) {
      const b = this.resolve(head, scope);
      if (b.kind === 'special') return b.sf;
    }
    return null;
  }

  // --- main entry points ---------------------------------------------------------
  analyze(x, scope) {
    if (x instanceof Sym) return this.analyzeRef(x, scope);
    if (x instanceof Pair) {
      const head = x.car;
      if (head instanceof SpecialForm) return head.fn(this, x, scope);
      if (head instanceof NativeMacro || head instanceof SyntaxRules) return this.analyze(head.expand(x, scope, this), scope);
      if (head instanceof Sym) {
        const b = this.resolve(head, scope);
        if (b.kind === 'special') return b.sf.fn(this, x, scope);
        if (b.kind === 'macro') return this.analyze(b.macro.expand(x, scope, this), scope);
      }
      return this.analyzeCall(x, scope);
    }
    return new Node(T.CONST, x);
  }

  headExpand(form, scope) {
    for (;;) {
      if (!(form instanceof Pair)) return form;
      const head = form.car;
      if (head instanceof NativeMacro || head instanceof SyntaxRules) { form = head.expand(form, scope, this); continue; }
      if (head instanceof Sym) {
        const b = this.resolve(head, scope);
        if (b.kind === 'macro') { form = b.macro.expand(form, scope, this); continue; }
      }
      return form;
    }
  }

  analyzeRef(sym, scope) {
    const b = this.resolve(sym, scope);
    switch (b.kind) {
      case 'local': {
        const d = depthBetween(scope, b.scope);
        const name = stripSym(sym).name;
        if (d === 0) return new Node(T.LOCAL0, b.index, name);
        if (d === 1) return new Node(T.LOCAL1, b.index, name);
        return new Node(T.LOCALN, d, b.index, name);
      }
      case 'global':
        return new Node(T.GLOBAL, this.interp.globalBox(b.sym));
      default:
        throw syntaxError('Syntactic keyword may not be used as an expression', stripSym(sym));
    }
  }

  makeCall(ops) {
    let simple = true;
    for (const o of ops) if (o.t > SIMPLE_MAX) { simple = false; break; }
    return new Node(T.CALL, ops, simple);
  }

  analyzeCall(x, scope) {
    const items = listToArray(x);
    if (items === null) throw syntaxError('Combination must be a proper list', stripForm(x));
    return this.makeCall(items.map((it) => this.analyze(it, scope)));
  }

  seq(forms, scope) {
    if (forms.length === 0) return UNSPEC_NODE;
    const nodes = forms.map((f) => this.analyze(f, scope));
    return nodes.length === 1 ? nodes[0] : new Node(T.SEQ, nodes);
  }

  // --- lambda / bodies ---------------------------------------------------------------
  makeLambda(params, bodyForms, scope, name) {
    const names = [];
    let nopt = 0, rest = false, mode = 'req', p = params;
    while (p instanceof Pair) {
      const s = p.car;
      if (!(s instanceof Sym)) throw syntaxError('Ill-formed special form', stripForm(params));
      const n = stripSym(s).name;
      if (n === '#!optional') { mode = 'opt'; p = p.cdr; continue; }
      if (n === '#!rest') { mode = 'rest'; p = p.cdr; continue; }
      names.push(s);
      if (mode === 'opt') nopt++; else if (mode === 'rest') rest = true;
      p = p.cdr;
    }
    if (p instanceof Sym) { names.push(p); rest = true; } else if (p !== NIL) throw syntaxError('Ill-formed special form', stripForm(params));
    const nreq = names.length - nopt - (rest ? 1 : 0);
    const s = new Scope(scope, names);
    if (bodyForms.length === 0) throw syntaxError('Ill-formed special form', stripForm(params));
    const body = this.analyzeBody(bodyForms, s);
    return new Node(T.LAMBDA, new LamInfo(nreq, nopt, rest, s.names.length, body, name));
  }

  // Body with internal defines: names are collected first (after expanding
  // macro uses in head position) so they're in scope for the whole body.
  analyzeBody(forms, scope) {
    const items = [];
    const scan = (form) => {
      form = this.headExpand(form, scope);
      if (form instanceof Pair) {
        const sf = this.specialOf(form.car, scope);
        if (sf === SF.begin) { for (const sub of toArr(form.cdr, form)) scan(sub); return; }
        if (sf === SF.define || sf === SF.defineIntegrable) {
          const name = defineTarget(form);
          if (!scope.names.includes(name)) scope.names.push(name);
          items.push(form);
          return;
        }
        if (sf === SF.defineSyntax) { this.defineSyntax(form, scope); return; }
      }
      items.push(form);
    };
    for (const f of forms) scan(f);
    const nodes = items.map((f) => this.analyze(f, scope));
    if (nodes.length === 0) return UNSPEC_NODE;
    return nodes.length === 1 ? nodes[0] : new Node(T.SEQ, nodes);
  }

  // --- macros -----------------------------------------------------------------------------
  makeMacro(spec, scope) {
    if (spec instanceof Pair && isKw(spec.car, 'syntax-rules')) return new SyntaxRules(spec, scope);
    throw syntaxError('Unsupported macro transformer (only syntax-rules is available)', stripForm(spec));
  }

  defineSyntax(x, scope) {
    if (!(x.cdr instanceof Pair) || !(x.cdr.cdr instanceof Pair) || !(x.cdr.car instanceof Sym)) throw bad(x);
    const name = x.cdr.car;
    const macro = this.makeMacro(x.cdr.cdr.car, scope);
    if (scope === null) {
      const base = stripSym(name);
      this.interp.macros.set(base, macro);
      this.interp.specials.delete(base);
    } else {
      if (!scope.macros) scope.macros = new Map();
      scope.macros.set(name, macro);
    }
    return UNSPEC_NODE;
  }
}

function defineTarget(form) {
  if (!(form.cdr instanceof Pair)) throw bad(form);
  let t = form.cdr.car;
  while (t instanceof Pair) t = t.car;
  if (!(t instanceof Sym)) throw bad(form);
  return t;
}

function nameHint(node, sym) {
  if (node.t === T.LAMBDA && !node.a.name) node.a.name = stripSym(sym).name;
  return node;
}

// --- special forms -------------------------------------------------------------------------
defSF('quote', (c, x) => {
  if (!(x.cdr instanceof Pair) || x.cdr.cdr !== NIL) throw bad(x);
  return new Node(T.CONST, strip(x.cdr.car));
});

defSF('if', (c, x, scope) => {
  const a = toArr(x.cdr, x);
  if (a.length < 2 || a.length > 3) throw bad(x);
  return new Node(T.IF, c.analyze(a[0], scope), c.analyze(a[1], scope), a.length === 3 ? c.analyze(a[2], scope) : UNSPEC_NODE);
});

defSF('lambda', (c, x, scope) => {
  if (!(x.cdr instanceof Pair)) throw bad(x);
  return c.makeLambda(x.cdr.car, toArr(x.cdr.cdr, x), scope, null);
});

defSF('named-lambda', (c, x, scope) => {
  if (!(x.cdr instanceof Pair) || !(x.cdr.car instanceof Pair)) throw bad(x);
  return c.makeLambda(x.cdr.car.cdr, toArr(x.cdr.cdr, x), scope, stripSym(x.cdr.car.car).name);
});

function sfDefine(c, x, scope) {
  if (!(x.cdr instanceof Pair)) throw bad(x);
  let target = x.cdr.car, valueNode, name;
  if (target instanceof Pair) {
    let params = target.cdr, body = toArr(x.cdr.cdr, x), head = target.car;
    while (head instanceof Pair) { // curried define
      body = [cons(SF.lambda, cons(params, arrayToList(body)))];
      params = head.cdr;
      head = head.car;
    }
    if (!(head instanceof Sym)) throw bad(x);
    name = head;
    valueNode = c.makeLambda(params, body, scope, stripSym(name).name);
  } else {
    if (!(target instanceof Sym)) throw bad(x);
    name = target;
    if (x.cdr.cdr === NIL) valueNode = new Node(T.CONST, UNASSIGNED);
    else {
      if (!(x.cdr.cdr instanceof Pair) || x.cdr.cdr.cdr !== NIL) throw bad(x);
      valueNode = nameHint(c.analyze(x.cdr.cdr.car, scope), name);
    }
  }
  const fs = frameScope(scope);
  if (fs === null) {
    const base = stripSym(name);
    c.interp.macros.delete(base);
    c.interp.specials.delete(base);
    return new Node(T.DEFGLOBAL, c.interp.globalBox(base), undefined, valueNode, base.name);
  }
  let idx = fs.names.indexOf(name);
  if (idx < 0) { fs.names.push(name); idx = fs.names.length - 1; }
  return new Node(T.SETLOCAL, depthBetween(scope, fs), idx + 1, valueNode, stripSym(name).name);
}
defSF('define', sfDefine);
defSF('define-integrable', sfDefine);
SF.defineIntegrable = SF['define-integrable'];

defSF('set!', (c, x, scope) => {
  const a = toArr(x.cdr, x);
  if (a.length !== 2 || !(a[0] instanceof Sym)) throw bad(x);
  const b = c.resolve(a[0], scope);
  const value = c.analyze(a[1], scope);
  if (b.kind === 'local') return new Node(T.SETLOCAL, depthBetween(scope, b.scope), b.index, value, stripSym(a[0]).name);
  if (b.kind === 'global') return new Node(T.SETGLOBAL, c.interp.globalBox(b.sym), undefined, value);
  throw syntaxError('Variable required in this context', stripSym(a[0]));
});

defSF('begin', (c, x, scope) => c.seq(toArr(x.cdr, x), scope));

defSF('and', (c, x, scope) => {
  const a = toArr(x.cdr, x);
  if (a.length === 0) return new Node(T.CONST, true);
  const nodes = a.map((f) => c.analyze(f, scope));
  return nodes.length === 1 ? nodes[0] : new Node(T.AND, nodes);
});
defSF('or', (c, x, scope) => {
  const a = toArr(x.cdr, x);
  if (a.length === 0) return new Node(T.CONST, false);
  const nodes = a.map((f) => c.analyze(f, scope));
  return nodes.length === 1 ? nodes[0] : new Node(T.OR, nodes);
});

defSF('let', (c, x, scope) => {
  if (!(x.cdr instanceof Pair)) throw bad(x);
  const second = x.cdr.car;
  if (second instanceof Sym) { // named let
    if (!(x.cdr.cdr instanceof Pair)) throw bad(x);
    const bindings = toArr(x.cdr.cdr.car, x);
    const body = toArr(x.cdr.cdr.cdr, x);
    const vars = bindings.map((b) => (b instanceof Pair ? b.car : b));
    const inits = bindings.map((b) => (b instanceof Pair && b.cdr instanceof Pair ? c.analyze(b.cdr.car, scope) : new Node(T.CONST, UNASSIGNED)));
    const scope1 = new Scope(scope, [second]);
    const lam = c.makeLambda(arrayToList(vars), body, scope1, stripSym(second).name);
    const letrec = new Node(T.LET, [ENVREF], 1, new Node(T.SEQ, [
      new Node(T.SETLOCAL, 0, 1, lam, stripSym(second).name),
      new Node(T.LOCAL0, 1, stripSym(second).name),
    ]));
    return c.makeCall([letrec, ...inits]);
  }
  const bindings = toArr(second, x);
  const names = [], inits = [];
  for (const b of bindings) {
    if (b instanceof Sym) { names.push(b); inits.push(new Node(T.CONST, UNASSIGNED)); }
    else if (b instanceof Pair && b.car instanceof Sym) {
      names.push(b.car);
      inits.push(b.cdr === NIL ? new Node(T.CONST, UNASSIGNED) : nameHint(c.analyze(b.cdr.car, scope), b.car));
    } else throw bad(x);
  }
  const scope1 = new Scope(scope, names.slice());
  const body = c.analyzeBody(toArr(x.cdr.cdr, x), scope1);
  if (x.cdr.cdr === NIL) throw bad(x);
  return new Node(T.LET, [ENVREF, ...inits], scope1.names.length - names.length, body);
});

function sfLetrec(c, x, scope) {
  if (!(x.cdr instanceof Pair) || x.cdr.cdr === NIL) throw bad(x);
  const bindings = toArr(x.cdr.car, x);
  const names = bindings.map((b) => {
    if (!(b instanceof Pair) || !(b.car instanceof Sym)) throw bad(x);
    return b.car;
  });
  const scope1 = new Scope(scope, names.slice());
  const sets = bindings.map((b, i) => new Node(T.SETLOCAL, 0, i + 1,
    b.cdr === NIL ? new Node(T.CONST, UNASSIGNED) : nameHint(c.analyze(b.cdr.car, scope1), b.car), stripSym(b.car).name));
  const body = c.analyzeBody(toArr(x.cdr.cdr, x), scope1);
  return new Node(T.LET, [ENVREF], scope1.names.length, new Node(T.SEQ, [...sets, body]));
}
defSF('letrec', sfLetrec);
defSF('letrec*', sfLetrec);

defSF('case', (c, x, scope) => {
  if (!(x.cdr instanceof Pair)) throw bad(x);
  const rawClauses = toArr(x.cdr.cdr, x);
  // A clause written (datums => proc) calls proc on the key: bind the key once
  // and rewrite those bodies to (proc key).
  if (rawClauses.some((cl) => cl instanceof Pair && cl.cdr instanceof Pair && isKw(cl.cdr.car, '=>'))) {
    const t = gensym('case-key');
    const newClauses = rawClauses.map((cl) => {
      if (!(cl instanceof Pair)) throw bad(x);
      if (cl.cdr instanceof Pair && isKw(cl.cdr.car, '=>')) {
        if (!(cl.cdr.cdr instanceof Pair) || cl.cdr.cdr.cdr !== NIL) throw bad(x);
        return list(cl.car, list(cl.cdr.cdr.car, t));
      }
      return cl;
    });
    return c.analyze(list(SF.let, list(list(t, x.cdr.car)), cons(SF.case, cons(t, arrayToList(newClauses)))), scope);
  }
  const key = c.analyze(x.cdr.car, scope);
  const clauses = [];
  let elseBody = null;
  for (const cl of rawClauses) {
    if (!(cl instanceof Pair)) throw bad(x);
    const bodyForms = toArr(cl.cdr, x);
    const body = c.seq(bodyForms, scope);
    if (isKw(cl.car, 'else')) elseBody = body;
    else clauses.push({ datums: toArr(strip(cl.car), x), body });
  }
  return new Node(T.CASE, key, clauses, elseBody);
});

defSF('delay', (c, x, scope) => {
  if (!(x.cdr instanceof Pair)) throw bad(x);
  return new Node(T.DELAY, c.analyze(x.cdr.car, scope));
});
defSF('delay-force', (c, x, scope) => {
  if (!(x.cdr instanceof Pair)) throw bad(x);
  return new Node(T.DELAY, c.analyze(list(c.prim('force'), x.cdr.car), scope));
});
defSF('cons-stream', (c, x, scope) => {
  const a = toArr(x.cdr, x);
  if (a.length !== 2) throw bad(x);
  return new Node(T.CONSSTREAM, c.analyze(a[0], scope), c.analyze(a[1], scope));
});

defSF('define-syntax', (c, x, scope) => c.defineSyntax(x, scope));
SF.defineSyntax = SF['define-syntax'];

function sfLetSyntax(recursive) {
  return (c, x, scope) => {
    if (!(x.cdr instanceof Pair)) throw bad(x);
    const scope1 = new Scope(scope, [], false);
    scope1.macros = new Map();
    for (const b of toArr(x.cdr.car, x)) {
      if (!(b instanceof Pair) || !(b.cdr instanceof Pair)) throw bad(x);
      scope1.macros.set(b.car, c.makeMacro(b.cdr.car, recursive ? scope1 : scope));
    }
    return c.seq(toArr(x.cdr.cdr, x), scope1);
  };
}
defSF('let-syntax', sfLetSyntax(false));
defSF('letrec-syntax', sfLetSyntax(true));

// Inside a procedure or let, the environment is the compile-time scope paired with the
// frame the machine is running in (ENVREF), captured as a LexicalEnv at run time.
const makeLexicalEnv = new Primitive('%make-environment', 2, 2, (scope, frame) => new LexicalEnv(scope, frame));
defSF('the-environment', (c, x, scope) => {
  if (!(x.cdr === NIL)) throw bad(x);
  if (frameScope(scope) === null) return new Node(T.CONST, c.interp.globalEnv);
  return c.makeCall([new Node(T.CONST, makeLexicalEnv), new Node(T.CONST, scope), ENVREF]);
});
defSF('declare', () => UNSPEC_NODE);

// --- native macros (derived forms) --------------------------------------------------------------
export const nativeMacros = {};
function defMacro(name, fn) { nativeMacros[name] = new NativeMacro(name, fn); }

defMacro('let*', (x) => {
  if (!(x.cdr instanceof Pair)) throw bad(x);
  const bindings = toArr(x.cdr.car, x);
  const body = x.cdr.cdr;
  if (bindings.length <= 1) return cons(SF.let, cons(x.cdr.car, body));
  let result = cons(SF.let, cons(list(bindings[bindings.length - 1]), body));
  for (let i = bindings.length - 2; i >= 0; i--) result = list(SF.let, list(bindings[i]), result);
  return result;
});

defMacro('when', (x) => {
  if (!(x.cdr instanceof Pair)) throw bad(x);
  return list(SF.if, x.cdr.car, cons(SF.begin, x.cdr.cdr));
});
defMacro('unless', (x) => {
  if (!(x.cdr instanceof Pair)) throw bad(x);
  return list(SF.if, x.cdr.car, UNSPEC, cons(SF.begin, x.cdr.cdr));
});

function expandCondClauses(clauses, i, x) {
  if (i >= clauses.length) return UNSPEC;
  const cl = clauses[i];
  if (!(cl instanceof Pair)) throw bad(x);
  const test = cl.car, rest = cl.cdr;
  if (isKw(test, 'else')) return cons(SF.begin, rest);
  if (rest === NIL) return list(SF.or, test, expandCondClauses(clauses, i + 1, x));
  if (rest instanceof Pair && isKw(rest.car, '=>') && rest.cdr instanceof Pair) {
    const t = gensym('cond-t');
    return list(SF.let, list(list(t, test)), list(SF.if, t, list(rest.cdr.car, t), expandCondClauses(clauses, i + 1, x)));
  }
  return list(SF.if, test, cons(SF.begin, rest), expandCondClauses(clauses, i + 1, x));
}
defMacro('cond', (x) => expandCondClauses(toArr(x.cdr, x), 0, x));

defMacro('do', (x) => {
  const a = toArr(x.cdr, x);
  if (a.length < 2) throw bad(x);
  const specs = toArr(a[0], x), testClause = toArr(a[1], x);
  if (testClause.length < 1) throw bad(x);
  const loop = gensym('do-loop');
  const bindings = [], steps = [];
  for (const s of specs) {
    const parts = toArr(s, x);
    if (parts.length < 2 || parts.length > 3) throw bad(x);
    bindings.push(list(parts[0], parts[1]));
    steps.push(parts.length === 3 ? parts[2] : parts[0]);
  }
  const resultForms = testClause.slice(1);
  const result = resultForms.length === 0 ? UNSPEC : cons(SF.begin, arrayToList(resultForms));
  const again = cons(loop, arrayToList(steps));
  const commands = a.slice(2);
  return list(SF.let, loop, arrayToList(bindings),
    list(SF.if, testClause[0], result, cons(SF.begin, arrayToList([...commands, again]))));
});

// --- quasiquote ---------------------------------------------------------------------------------------------
function hasUnquote(x) {
  if (x instanceof Pair) {
    if (isKw(x.car, 'unquote') || isKw(x.car, 'unquote-splicing') || isKw(x.car, 'quasiquote')) return true;
    return hasUnquote(x.car) || hasUnquote(x.cdr);
  }
  if (Array.isArray(x)) return x.some(hasUnquote);
  return false;
}
function qq(x, d, c) {
  if (!hasUnquote(x)) return list(SF.quote, x);
  if (Array.isArray(x)) return list(c.prim('list->vector'), qq(arrayToList(x), d, c));
  if (!(x instanceof Pair)) return list(SF.quote, x);
  if (isKw(x.car, 'unquote') && x.cdr instanceof Pair) {
    if (d === 1) return x.cdr.car;
    return list(c.prim('list'), list(SF.quote, intern('unquote')), qq(x.cdr.car, d - 1, c));
  }
  if (isKw(x.car, 'quasiquote') && x.cdr instanceof Pair) {
    return list(c.prim('list'), list(SF.quote, intern('quasiquote')), qq(x.cdr.car, d + 1, c));
  }
  if (x.car instanceof Pair && isKw(x.car.car, 'unquote-splicing') && x.car.cdr instanceof Pair) {
    if (d === 1) return list(c.prim('append'), x.car.cdr.car, qq(x.cdr, d, c));
    return list(c.prim('cons'),
      list(c.prim('list'), list(SF.quote, intern('unquote-splicing')), qq(x.car.cdr.car, d - 1, c)),
      qq(x.cdr, d, c));
  }
  return list(c.prim('cons'), qq(x.car, d, c), qq(x.cdr, d, c));
}
defMacro('quasiquote', (x, scope, c) => {
  if (!(x.cdr instanceof Pair) || x.cdr.cdr !== NIL) throw bad(x);
  return qq(x.cdr.car, 1, c);
});

// --- records ------------------------------------------------------------------------------------------------------
defMacro('define-record-type', (x, scope, c) => {
  const a = toArr(x.cdr, x);
  if (a.length < 3) throw bad(x);
  let typeName = a[0];
  if (typeName instanceof Pair) typeName = typeName.car;
  if (!(typeName instanceof Sym)) throw bad(x);
  const displayName = stripSym(typeName).name.replace(/^<(.*)>$/, '$1');
  const fieldSpecs = a.slice(3).map((f) => (f instanceof Sym ? [f] : toArr(f, x)));
  const fieldNames = fieldSpecs.map((f) => stripSym(f[0]).name);
  const type = new RecordType(displayName, fieldNames);
  const defs = [list(SF.define, typeName, type)];
  const ctor = a[1];
  if (ctor instanceof Pair || ctor instanceof Sym) {
    const cname = ctor instanceof Pair ? ctor.car : ctor;
    const cfields = ctor instanceof Pair ? toArr(ctor.cdr, x).map((f) => fieldNames.indexOf(stripSym(f).name)) : fieldNames.map((_, i) => i);
    if (cfields.some((i) => i < 0)) throw bad(x);
    const n = cfields.length, total = fieldNames.length;
    const nm = stripSym(cname).name;
    defs.push(list(SF.define, cname, new Primitive(nm, n, n, (...args) => {
      const vals = new Array(total).fill(false);
      for (let i = 0; i < n; i++) vals[cfields[i]] = args[i];
      return new Record(type, vals);
    })));
  }
  if (a[2] instanceof Sym) {
    defs.push(list(SF.define, a[2], new Primitive(stripSym(a[2]).name, 1, 1, (r) => r instanceof Record && r.type === type)));
  }
  fieldSpecs.forEach((f, idx) => {
    if (f[1]) {
      const nm = stripSym(f[1]).name;
      defs.push(list(SF.define, f[1], new Primitive(nm, 1, 1, (r) => {
        if (!(r instanceof Record) || r.type !== type) throw wrongType(r, 1, nm);
        return r.vals[idx];
      })));
    }
    if (f[2]) {
      const nm = stripSym(f[2]).name;
      defs.push(list(SF.define, f[2], new Primitive(nm, 2, 2, (r, v) => {
        if (!(r instanceof Record) || r.type !== type) throw wrongType(r, 1, nm);
        r.vals[idx] = v;
        return UNSPEC;
      })));
    }
  });
  return cons(SF.begin, arrayToList(defs));
});

// (define-structure name field ...) / (define-structure (name) field ...): constructor
// make-NAME taking every field in order, predicate NAME?, accessors NAME-FIELD and
// modifiers set-NAME-FIELD!. A field may be written (field default); the default is
// ignored because the constructor always takes all fields. Options are not supported.
defMacro('define-structure', (x) => {
  const a = toArr(x.cdr, x);
  if (a.length < 1) throw bad(x);
  let nameSym = a[0];
  if (nameSym instanceof Pair) {
    if (nameSym.cdr !== NIL) throw syntaxError('define-structure options are not supported', stripForm(nameSym));
    nameSym = nameSym.car;
  }
  if (!(nameSym instanceof Sym)) throw bad(x);
  const name = stripSym(nameSym).name;
  const fields = a.slice(1).map((f) => {
    const s = f instanceof Pair ? f.car : f;
    if (!(s instanceof Sym)) throw bad(x);
    return stripSym(s).name;
  });
  const specs = fields.map((f) => list(intern(f), intern(name + '-' + f), intern('set-' + name + '-' + f + '!')));
  return cons(nativeMacros['define-record-type'], cons(intern('<' + name + '>'),
    cons(cons(intern('make-' + name), arrayToList(fields.map((f) => intern(f)))),
      cons(intern(name + '?'), arrayToList(specs)))));
});

// Shape checks on a `cases` form. Whether each variant belongs to the datatype, has the right number
// of fields, or is covered at all is checked when the clause is reached, not here: code written for
// other implementations of this vocabulary may define or redefine its datatype after the function
// that uses it.
function checkCases(c, tname, clauses, x) {
  if (!(tname instanceof Sym)) throw syntaxError('cases: not a datatype name', stripForm(x));
  clauses.forEach((cl, i) => {
    if (isKw(cl[0], 'else') && i !== clauses.length - 1) throw syntaxError('cases: else clause must be last', stripForm(x));
  });
}

// (%cases type expr (variant (field ...) body ...) ... [(else body ...)]): the engine behind
// `cases` in prelude/eopl.scm. Expands to a chain of tests on the variant's name, each binding
// the clause's fields straight from the variant's slots (no argument list is built).
defMacro('%cases', (x, scope, c) => {
  const a = toArr(x.cdr, x);
  if (a.length < 2) throw bad(x);
  const tname = a[0], v = gensym('cases');
  const clauses = a.slice(2).map((cl) => toArr(cl, x));
  checkCases(c, tname, clauses, x);
  let chain = list(c.prim('%cases-no-match'), list(SF.quote, tname), v);
  for (let i = clauses.length - 1; i >= 0; i--) {
    const cl = clauses[i];
    if (cl.length < 1) throw bad(x);
    if (isKw(cl[0], 'else')) {
      if (i !== clauses.length - 1) throw bad(x);
      chain = cons(SF.let, cons(NIL, arrayToList(cl.slice(1))));
      continue;
    }
    if (cl.length < 3) throw bad(x);
    const fields = toArr(cl[1], x);
    const bindings = fields.map((f, idx) => list(f, list(c.prim('%variant-ref'), v, idx)));
    chain = list(SF.if, list(c.prim('%variant-is?'), v, list(SF.quote, cl[0]), fields.length),
      cons(SF.let, cons(arrayToList(bindings), arrayToList(cl.slice(2)))), chain);
  }
  return list(SF.let, list(list(v, a[1])), list(c.prim('%cases-check'), list(SF.quote, tname), v), chain);
});

// --- multiple values --------------------------------------------------------------------------------------------------
defMacro('receive', (x, scope, c) => {
  const a = toArr(x.cdr, x);
  if (a.length < 3) throw bad(x);
  return list(c.prim('call-with-values'), list(SF.lambda, NIL, a[1]), cons(SF.lambda, cons(a[0], arrayToList(a.slice(2)))));
});
function expandLetValues(bindings, body, c, x) {
  if (bindings.length === 0) return cons(SF.let, cons(NIL, body));
  const b = toArr(bindings[0], x);
  if (b.length !== 2) throw bad(x);
  return list(c.prim('call-with-values'), list(SF.lambda, NIL, b[1]),
    list(SF.lambda, b[0], expandLetValues(bindings.slice(1), body, c, x)));
}
defMacro('let-values', (x, scope, c) => expandLetValues(toArr(x.cdr.car, x), x.cdr.cdr, c, x));
defMacro('let*-values', (x, scope, c) => expandLetValues(toArr(x.cdr.car, x), x.cdr.cdr, c, x));
defMacro('define-values', (x, scope, c) => {
  const a = toArr(x.cdr, x);
  if (a.length !== 2) throw bad(x);
  const vars = [];
  let p = a[0];
  while (p instanceof Pair) { vars.push(p.car); p = p.cdr; }
  const restVar = p instanceof Sym ? p : null;
  const all = restVar ? [...vars, restVar] : vars;
  const temps = all.map(() => gensym('dv'));
  const formals = arrayToList(temps.slice(0, vars.length), restVar ? temps[temps.length - 1] : NIL);
  const defs = all.map((v) => list(SF.define, v));
  const sets = all.map((v, i) => list(SF['set!'], v, temps[i]));
  return cons(SF.begin, arrayToList([...defs,
    list(c.prim('call-with-values'), list(SF.lambda, NIL, a[1]), cons(SF.lambda, cons(formals, arrayToList(sets))))]));
});

// --- guard (R7RS reference expansion) ---------------------------------------------------------------------------------------
defMacro('guard', (x, scope, c) => {
  if (!(x.cdr instanceof Pair) || !(x.cdr.car instanceof Pair)) throw bad(x);
  const v = x.cdr.car.car;
  const clauses = toArr(x.cdr.car.cdr, x);
  const body = x.cdr.cdr;
  const guardK = gensym('guard-k'), handlerK = gensym('handler-k'), condition = gensym('condition'), args = gensym('args');
  const hasElse = clauses.length > 0 && clauses[clauses.length - 1] instanceof Pair && isKw(clauses[clauses.length - 1].car, 'else');
  const reraise = list(handlerK, list(SF.lambda, NIL, list(c.prim('raise-continuable'), condition)));
  const allClauses = hasElse ? clauses : [...clauses, list(intern('else'), reraise)];
  const handlerBody = list(SF.let, list(list(v, condition)), cons(nativeMacros.cond, arrayToList(allClauses)));
  const callcc = c.prim('call-with-current-continuation');
  return list(list(callcc, list(SF.lambda, list(guardK),
    list(c.prim('with-exception-handler'),
      list(SF.lambda, list(condition),
        list(list(callcc, list(SF.lambda, list(handlerK),
          list(guardK, list(SF.lambda, NIL, handlerBody)))))),
      list(SF.lambda, NIL,
        list(c.prim('call-with-values'), cons(SF.lambda, cons(NIL, body)),
          list(SF.lambda, args, list(guardK, list(SF.lambda, NIL, list(c.prim('apply'), c.prim('values'), args))))))))));
});
