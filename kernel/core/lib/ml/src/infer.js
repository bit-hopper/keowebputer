// The elaborator for the core language (no modules yet): Hindley-Milner inference with levels, equality types,
// datatypes, exceptions, and the book's two kinds of "no": nonsense (no type) and ungrammatical.
//
//   const el = new Elaborator({ style: 'book' });
//   const r = el.elaborateItem(derive(item), globalScope);
//   r.scope     a fresh child of globalScope holding what the item defined; the caller merges it on success
//               (`r.scope.mergeInto(globalScope)`), so a failed item changes nothing
//   r.ir        { decs: [...] }, what the machine runs (below)
//   r.echo      what to print, in declaration order:
//                 {kind:'val', name, type, expStmt?}  {kind:'datatype', names:[TyName]}  {kind:'type', name, params, body}
//                 {kind:'exception', name, ty}
//   r.matchSites  every match, for the pattern checker: {kind:'fn'|'handle'|'val', origin, loc, ruleLocs, ty, rules:[patIR]}
//
// IR. Expressions: {op:'const', value} {op:'var', name} {op:'con', con} {op:'conapp', con, arg} {op:'prim', name}
//   {op:'list', items} (a list literal [a, b, c])  {op:'tuple', items} {op:'app', fn, arg} {op:'if', cond, then, else} {op:'fn', rules:[{pat, body}], origin}
//   {op:'let', decs, body} {op:'raise', exp} {op:'handle', exp, rules}
// Patterns: {p:'wild'} {p:'var', name} {p:'int', value} {p:'str', value} {p:'chr', value} {p:'con', con, arg|null} {p:'exn', name, arg|null}
//   {p:'tuple', items}.   (Exception constructors are run-time values, found by name; datatype constructors are
//   resolved here to their ConInfo.)
// Declarations: {d:'val', binds:[{pat, exp}], recs:[{name, exp}]} (binds' expressions run in the old environment, recs'
//   closures see the rec names; then everything is bound)  {d:'exception', binds:[{name, hasArg}]}
//   {d:'local', head:[dec], body:[dec]}.   Datatype and type declarations have no run-time part.
import { MLError, ungrammatical } from './errors.js';
import { unify, UnifyFailure } from './unify.js';
import {
  TVar, TyName, prune, tcon, tfn, ttuple, tInt, tBool, tExn, tString, tChar, tList,
  generalize, instantiate, substitute, admitsEq, typeToString, tyNameText, freeVars,
} from './types.js';
import { hasListBasis, NIL_INFO, CONS_INFO } from './basis.js';
import { charValue } from './values.js';
import { moduleMethods, firstAbstract } from './modules.js';

const nonsense = (message, where) => new MLError('nonsense', message, where && (where.loc || where));

// The type variables written anywhere inside a declaration (annotations), by name.
function collectTyvars(node, out = new Set()) {
  if (Array.isArray(node)) { node.forEach((x) => collectTyvars(x, out)); return out; }
  if (node === null || typeof node !== 'object') return out;
  if (node.kind === 'tyvar') out.add(node.name);
  for (const k of Object.keys(node)) if (k !== 'loc') collectTyvars(node[k], out);
  return out;
}

const isEqName = (n) => n.startsWith("''");

export class Elaborator {
  constructor(options = {}) {
    this.style = options.style || 'book';
  }

  // ---- entry ----------------------------------------------------------------------------------------------

  elaborateItem(item, global) {
    this.scope = global.child();
    this.level = 0;
    this.tyvarScope = new Map();
    this.matchSites = [];
    this.echo = [];
    let decs;
    if (item.kind === 'expstmt') {
      decs = [this.valDec({
        kind: 'val', loc: item.loc,
        binds: [{ rec: false, pat: { kind: 'pid', name: 'it', qual: null, forceVar: true, loc: item.loc }, exp: item.exp }],
      }, true)];
    } else {
      decs = this.dec(item);
    }
    return { scope: this.scope, ir: { decs }, echo: this.echo, matchSites: this.matchSites };
  }

  // ---- helpers ---------------------------------------------------------------------------------------------

  fresh() { return new TVar(this.level); }

  show(t, names) { return typeToString(t, this.style, names || new Map()); }

  // Unify, turning a failure into a nonsense error. `describe(names)` words the ordinary mismatch (it is handed a Map
  // that keeps type-variable names consistent across the types it mentions).
  unifyOr(a, b, node, describe) {
    try {
      unify(a, b);
    } catch (e) {
      if (!(e instanceof UnifyFailure)) throw e;
      const names = new Map();
      if (e.reason === 'occurs') {
        throw nonsense('this would need a type that contains itself (a circular type), as in fn x => x x', node);
      }
      if (e.reason === 'overload') {
        throw nonsense('< > <= and >= compare an int, a string or a char, but here the operands would have type ' + this.show(e.a, names), node);
      }
      if (e.reason === 'equality') {
        throw nonsense('equality is needed here, but ' + this.show(e.a, names) + ' does not admit equality (functions never do)', node);
      }
      let message = describe(names);
      // two different types with one name (a datatype declared again hides the earlier one without replacing it): say so, since
      // the two would otherwise print identically
      const x = prune(e.a);
      const y = prune(e.b);
      if (x.tag === 'con' && y.tag === 'con' && x.name !== y.name && tyNameText(x.name) === tyNameText(y.name)) {
        message += '; these are two different types that are both named ' + tyNameText(x.name) + ' (declaring a type again hides the earlier one, it does not replace it)';
      }
      const hidden = firstAbstract(a) || firstAbstract(b);
      if (hidden) { // the clash involves a type some signature hides: the book's "signature nonsense"
        throw new MLError('signature', message + '; ' + tyNameText(hidden) + ' is an abstract type here, so what it is has been hidden', node.loc || node);
      }
      throw nonsense(message, node);
    }
  }

  // List, string and char syntax needs the lists-and-strings basis (an interpreter can be started without it).
  needBasis(node, what) {
    if (!hasListBasis(this.scope.root())) {
      throw nonsense(what + ' are not part of the core basis this interpreter was started with', node);
    }
  }

  // ---- types in the source ---------------------------------------------------------------------------------

  elabType(ty, tvars) {
    switch (ty.kind) {
      case 'tyvar': {
        const v = tvars.get(ty.name);
        if (!v) throw nonsense('the type variable ' + ty.name + ' is not bound here', ty);
        return v;
      }
      case 'ttuple': return ttuple(ty.items.map((x) => this.elabType(x, tvars)));
      case 'arrow': return tfn(this.elabType(ty.from, tvars), this.elabType(ty.to, tvars));
      case 'tycon': {
        const entry = ty.qual ? this.lookupQualType(ty) : this.scope.lookupType(ty.name);
        if (!entry) throw nonsense('the type ' + ty.name + ' is not defined', ty);
        const args = ty.args.map((x) => this.elabType(x, tvars));
        if (entry.kind === 'tyname') {
          if (args.length !== entry.tyname.arity) {
            throw nonsense('the type ' + ty.name + ' takes ' + entry.tyname.arity + ' type argument' + (entry.tyname.arity === 1 ? '' : 's') + ', but was given ' + args.length, ty);
          }
          return tcon(entry.tyname, args);
        }
        if (args.length !== entry.params.length) {
          throw nonsense('the type ' + ty.name + ' takes ' + entry.params.length + ' type argument' + (entry.params.length === 1 ? '' : 's') + ', but was given ' + args.length, ty);
        }
        return substitute(entry.body, entry.params, args);
      }
      default:
        throw new MLError('internal', 'elabType: ' + ty.kind, ty.loc);
    }
  }

  // Annotation type variables are scoped over the outermost enclosing val/fun, and are rigid inside it: they unify with
  // nothing but themselves (SML/NJ does the same). Returns the names bound here, to unbind afterwards.
  bindTyvars(node) {
    const bound = [];
    for (const name of collectTyvars(node)) {
      if (this.tyvarScope.has(name)) continue;
      const v = new TVar(this.level + 1, isEqName(name));
      v.rigid = true;
      v.name = name;
      this.tyvarScope.set(name, v);
      bound.push(name);
    }
    return bound;
  }

  // ---- patterns --------------------------------------------------------------------------------------------

  lookupValue(node) {
    if (node.qual) return this.lookupQualVal(node);
    const info = node.basis ? this.scope.root().lookupVal(node.name) : this.scope.lookupVal(node.name);
    return info;
  }

  pat(p, vars) {
    switch (p.kind) {
      case 'wild': return { ty: this.fresh(), ir: { p: 'wild' } };
      case 'pint': return { ty: tInt, ir: { p: 'int', value: p.value } };
      case 'pstring': this.needBasis(p, 'strings'); return { ty: tString, ir: { p: 'str', value: p.value } };
      case 'pchar': this.needBasis(p, 'characters'); return { ty: tChar, ir: { p: 'chr', value: p.value } };
      case 'plist': {
        this.needBasis(p, 'lists');
        const elem = this.fresh();
        const items = p.items.map((x, i) => {
          const r = this.pat(x, vars);
          this.unifyOr(r.ty, elem, x, (n) => 'the patterns of a list must all have the same type: this one has type ' + this.show(r.ty, n) + ', but the ones before it have type ' + this.show(elem, n));
          return r;
        });
        let ir = { p: 'con', con: NIL_INFO, arg: null };
        for (let i = items.length - 1; i >= 0; i--) ir = { p: 'con', con: CONS_INFO, arg: { p: 'tuple', items: [items[i].ir, ir] } };
        return { ty: tList(elem), ir };
      }
      case 'pid': {
        const info = p.forceVar ? null : this.lookupValue(p);
        if (info && (info.kind === 'con' || info.kind === 'exn')) {
          if (info.hasArg) throw nonsense(p.name + ' takes an argument, so it cannot stand alone in a pattern', p);
          const ty = instantiate(info.scheme, this.level);
          return { ty, ir: info.kind === 'con' ? { p: 'con', con: info, arg: null } : { p: 'exn', name: p.name, qual: p.qual || null, arg: null } };
        }
        if (p.qual) throw ungrammatical(p.qual.join('.') + '.' + p.name + ' is not a constructor, so it cannot be a pattern', p.loc);
        if (vars.has(p.name)) throw ungrammatical('the name ' + p.name + ' appears twice in one pattern', p.loc);
        const ty = this.fresh();
        vars.set(p.name, { ty, node: p });
        return { ty, ir: { p: 'var', name: p.name } };
      }
      case 'pcon': {
        const c = p.con;
        const info = this.lookupValue(c);
        if (!info || (info.kind !== 'con' && info.kind !== 'exn')) {
          throw ungrammatical(c.name + ' is not a constructor, so it cannot be applied to an argument in a pattern', c.loc);
        }
        if (!info.hasArg) throw nonsense(c.name + ' does not take an argument', p);
        const ft = instantiate(info.scheme, this.level); // arg -> result
        const arg = this.pat(p.arg, vars);
        this.unifyOr(arg.ty, ft.from, p.arg, (n) => c.name + ' takes ' + this.show(ft.from, n) + ', but this pattern has type ' + this.show(arg.ty, n));
        return { ty: ft.to, ir: info.kind === 'con' ? { p: 'con', con: info, arg: arg.ir } : { p: 'exn', name: c.name, qual: c.qual || null, arg: arg.ir } };
      }
      case 'ptuple': {
        const items = p.items.map((x) => this.pat(x, vars));
        return { ty: ttuple(items.map((i) => i.ty)), ir: { p: 'tuple', items: items.map((i) => i.ir) } };
      }
      case 'ptyped': {
        const inner = this.pat(p.pat, vars);
        const at = this.elabType(p.ty, this.tyvarScope);
        this.unifyOr(inner.ty, at, p, (n) => 'this pattern has type ' + this.show(inner.ty, n) + ', but is annotated ' + this.show(at, n));
        return inner;
      }
      default:
        throw new MLError('internal', 'pat: ' + p.kind, p.loc);
    }
  }

  // ---- expressions -----------------------------------------------------------------------------------------

  exp(e) {
    switch (e.kind) {
      case 'int': return { ty: tInt, ir: { op: 'const', value: e.value } };
      case 'var': return this.varExp(e);
      case 'string': this.needBasis(e, 'strings'); return { ty: tString, ir: { op: 'const', value: e.value } };
      case 'char': this.needBasis(e, 'characters'); return { ty: tChar, ir: { op: 'const', value: charValue(e.value) } };
      case 'list': {
        this.needBasis(e, 'lists');
        const elem = this.fresh();
        const items = e.items.map((x) => {
          const r = this.exp(x);
          this.unifyOr(r.ty, elem, x, (n) => 'the elements of a list must all have the same type: this one has type ' + this.show(r.ty, n) + ', but the ones before it have type ' + this.show(elem, n));
          return r.ir;
        });
        return { ty: tList(elem), ir: { op: 'list', items } };
      }
      case 'tuple': {
        const items = e.items.map((x) => this.exp(x));
        return { ty: ttuple(items.map((i) => i.ty)), ir: { op: 'tuple', items: items.map((i) => i.ir) } };
      }
      case 'app': return this.appExp(e);
      case 'typed': {
        const inner = this.exp(e.exp);
        const at = this.elabType(e.ty, this.tyvarScope);
        this.unifyOr(inner.ty, at, e, (n) => 'this expression has type ' + this.show(inner.ty, n) + ', but is annotated ' + this.show(at, n));
        return { ty: at, ir: inner.ir };
      }
      case 'if': {
        const c = this.exp(e.cond);
        this.unifyOr(c.ty, tBool, e.cond, (n) => 'the test of an if must be a bool, but this is ' + this.show(c.ty, n));
        const t = this.exp(e.then);
        const f = this.exp(e.else);
        this.unifyOr(f.ty, t.ty, e.else, (n) => 'the two branches of this if have different types: ' + this.show(t.ty, n) + ' and ' + this.show(f.ty, n));
        return { ty: t.ty, ir: { op: 'if', cond: c.ir, then: t.ir, else: f.ir } };
      }
      case 'fn': {
        const param = this.fresh();
        const result = this.fresh();
        const rules = this.rules(e.match, param, result, e, 'result');
        this.matchSites.push({ kind: 'fn', origin: e.origin, loc: e.loc, ruleLocs: e.match.map((r) => r.pat.loc), ty: param, rules: rules.map((r) => r.pat) });
        return { ty: tfn(param, result), ir: { op: 'fn', rules, origin: e.origin } };
      }
      case 'let': {
        const saved = this.scope;
        const savedEcho = this.echo;
        this.scope = saved.child();
        this.echo = [];
        let decs;
        let body;
        try {
          decs = [];
          for (const d of e.decs) decs.push(...this.dec(d));
          body = this.exp(e.body);
        } finally {
          this.scope = saved;
          this.echo = savedEcho;
        }
        return { ty: body.ty, ir: { op: 'let', decs, body: body.ir } };
      }
      case 'raise': {
        const x = this.exp(e.exp);
        this.unifyOr(x.ty, tExn, e.exp, (n) => 'raise needs an exn value, but this is ' + this.show(x.ty, n));
        return { ty: this.fresh(), ir: { op: 'raise', exp: x.ir } };
      }
      case 'handle': {
        const x = this.exp(e.exp);
        const rules = this.rules(e.match, tExn, x.ty, e, 'handler');
        this.matchSites.push({ kind: 'handle', loc: e.loc, ruleLocs: e.match.map((r) => r.pat.loc), ty: tExn, rules: rules.map((r) => r.pat) });
        return { ty: x.ty, ir: { op: 'handle', exp: x.ir, rules } };
      }
      default:
        throw new MLError('internal', 'exp: ' + e.kind, e.loc);
    }
  }

  // Elaborate match rules whose patterns have type `argTy` and whose bodies have type `resTy`.
  rules(match, argTy, resTy, owner, what) {
    return match.map((r, i) => {
      const vars = new Map();
      const p = this.pat(r.pat, vars);
      this.unifyOr(p.ty, argTy, r.pat, (n) => (i === 0 && what === 'handler'
        ? 'a handler pattern must match an exn, but this pattern has type ' + this.show(p.ty, n)
        : 'this pattern has type ' + this.show(p.ty, n) + ', but ' + (i === 0 ? 'it is matched against ' : 'the earlier patterns have type ') + this.show(argTy, n)));
      const saved = this.scope;
      this.scope = saved.child();
      for (const [name, v] of vars) this.scope.vals.set(name, { kind: 'var', scheme: v.ty });
      let body;
      try { body = this.exp(r.exp); } finally { this.scope = saved; }
      this.unifyOr(body.ty, resTy, r.exp, (n) => 'this ' + what + ' has type ' + this.show(body.ty, n) + ', but ' + (what === 'handler' ? 'the expression it guards has type ' : 'the earlier ones have type ') + this.show(resTy, n));
      return { pat: p.ir, body: body.ir };
    });
  }

  varExp(e) {
    const info = this.lookupValue(e);
    if (!info) throw nonsense(e.name + ' is not defined', e);
    const ty = instantiate(info.scheme, this.level);
    switch (info.kind) {
      case 'var': case 'exn': return { ty, ir: e.qual ? { op: 'qvar', path: e.qual, name: e.name } : { op: 'var', name: e.name } };
      case 'con': return { ty, ir: { op: 'con', con: info } };
      case 'prim': return { ty, ir: { op: 'prim', name: info.name } };
      default: throw new MLError('internal', 'varExp: ' + info.kind, e.loc);
    }
  }

  appExp(e) {
    const f = this.exp(e.fn);
    const a = this.exp(e.arg);
    const name = e.fn.kind === 'var' ? e.fn.name : null;
    const ft = prune(f.ty);
    let result;
    if (ft.tag === 'fn') {
      this.unifyOr(a.ty, ft.from, e.arg, (n) => (name ? name : 'this function') + ' consumes ' + this.show(ft.from, n) + ', but was given ' + this.show(a.ty, n));
      result = ft.to;
    } else if (ft.tag === 'var' && !ft.rigid) {
      result = this.fresh();
      this.unifyOr(ft, tfn(a.ty, result), e, () => 'internal: could not make a function type');
    } else {
      const n = new Map();
      throw nonsense((name ? name : 'this expression') + ' is not a function: it has type ' + this.show(ft, n) + ', but it is applied to an argument', e);
    }
    if (f.ir.op === 'con' && f.ir.con.hasArg) return { ty: result, ir: { op: 'conapp', con: f.ir.con, arg: a.ir } };
    return { ty: result, ir: { op: 'app', fn: f.ir, arg: a.ir } };
  }

  // ---- declarations ----------------------------------------------------------------------------------------

  // Elaborate one declaration into `this.scope`; returns its run-time IR declarations.
  dec(d) {
    switch (d.kind) {
      case 'val': return [this.valDec(d, false)];
      case 'datatype': this.datatypeDec(d); return [];
      case 'type': this.typeDec(d); return [];
      case 'exception': return [this.exceptionDec(d)];
      case 'local': return [this.localDec(d)];
      case 'signature': return this.signatureDec(d);
      case 'structure': return this.structureDec(d);
      case 'functor': return this.functorDec(d);
      case 'open': return this.openDec(d);
      default: throw new MLError('internal', 'dec: ' + d.kind, d.loc);
    }
  }

  valDec(d, expStmt) {
    const boundNames = this.bindTyvars(d);
    this.level++;
    try {
      const recFrom = d.binds.findIndex((b) => b.rec);
      const infos = [];
      const seen = new Map();
      for (const b of d.binds) {
        const vars = new Map();
        const p = this.pat(b.pat, vars);
        for (const [name] of vars) {
          if (seen.has(name)) throw ungrammatical('the name ' + name + ' is bound twice in one declaration', b.pat.loc);
          seen.set(name, true);
        }
        infos.push({ b, p, vars });
      }
      // the scope the recursive bindings' expressions see: their own names, monomorphic
      let recScope = this.scope;
      if (recFrom >= 0) {
        recScope = this.scope.child();
        for (let i = recFrom; i < infos.length; i++) {
          for (const [name, v] of infos[i].vars) recScope.vals.set(name, { kind: 'var', scheme: v.ty });
        }
      }
      const binds = [];
      const recs = [];
      infos.forEach((info, i) => {
        const isRec = recFrom >= 0 && i >= recFrom;
        const saved = this.scope;
        this.scope = isRec ? recScope : saved;
        let x;
        try { x = this.exp(info.b.exp); } finally { this.scope = saved; }
        this.unifyOr(x.ty, info.p.ty, info.b.exp, (n) => 'this pattern has type ' + this.show(info.p.ty, n) + ', but the expression has type ' + this.show(x.ty, n));
        if (isRec) {
          if (info.b.exp.kind !== 'fn' || info.p.ir.p !== 'var') {
            throw ungrammatical('val rec binds a name to a function: the right-hand side must be a fn', info.b.exp.loc);
          }
          recs.push({ name: info.p.ir.name, exp: x.ir });
        } else {
          binds.push({ pat: info.p.ir, exp: x.ir });
          this.matchSites.push({ kind: 'val', loc: info.b.pat.loc, ty: info.p.ty, rules: [info.p.ir] });
        }
      });
      this.level--;
      for (const info of infos) {
        for (const [name, v] of info.vars) {
          // at the top level a comparison whose operands nothing has pinned down is on ints (the Definition's default); in a
          // nested declaration it stays open for the enclosing one to decide
          if (this.level === 0) for (const fv of freeVars(v.ty)) if (fv.ord && !fv.rigid) fv.ref = tInt;
          generalize(v.ty, this.level);
          this.scope.vals.set(name, { kind: 'var', scheme: v.ty });
          this.echo.push({ kind: 'val', name, type: v.ty, expStmt: !!expStmt });
        }
      }
      return { d: 'val', binds, recs };
    } finally {
      // (on an error the whole item scope is dropped, so a stale level here does not matter)
      for (const n of boundNames) this.tyvarScope.delete(n);
    }
  }

  datatypeDec(d) {
    const names = [];
    for (const b of d.binds) {
      const tn = new TyName(b.name, b.tyvars.length, true);
      tn.isDatatype = true;
      tn.params = b.tyvars.map((n) => { const v = new TVar(0, isEqName(n)); v.generic = true; return v; });
      names.push(tn);
      this.scope.types.set(b.name, { kind: 'tyname', tyname: tn });
    }
    d.binds.forEach((b, i) => {
      const tn = names[i];
      const tvars = new Map(b.tyvars.map((n, j) => [n, tn.params[j]]));
      const result = tcon(tn, tn.params);
      const seen = new Set();
      b.cons.forEach((c, index) => {
        if (seen.has(c.name)) throw ungrammatical('the constructor ' + c.name + ' appears twice in datatype ' + b.name, c.loc);
        seen.add(c.name);
        const argTy = c.ty ? this.elabType(c.ty, tvars) : null;
        const info = { kind: 'con', name: c.name, scheme: argTy ? tfn(argTy, result) : result, tyname: tn, hasArg: !!argTy, index };
        tn.cons.push({ name: c.name, ty: argTy, info });
        this.scope.vals.set(c.name, info);
      });
    });
    // equality: a datatype admits it unless some constructor carries a function or a type that does not (greatest fixed point)
    for (let changed = true; changed;) {
      changed = false;
      for (const tn of names) {
        if (tn.admitsEq && !tn.cons.every((c) => c.ty === null || admitsEq(c.ty))) { tn.admitsEq = false; changed = true; }
      }
    }
    this.echo.push({ kind: 'datatype', names });
  }

  typeDec(d) {
    const made = d.binds.map((b) => {
      const params = b.tyvars.map((n) => new TVar(0, isEqName(n)));
      const body = this.elabType(b.ty, new Map(b.tyvars.map((n, j) => [n, params[j]])));
      return { name: b.name, params, body };
    });
    for (const m of made) {
      this.scope.types.set(m.name, { kind: 'abbrev', params: m.params, body: m.body });
      this.echo.push({ kind: 'type', name: m.name, params: m.params, body: m.body });
    }
  }

  exceptionDec(d) {
    const binds = [];
    for (const b of d.binds) {
      const argTy = b.ty ? this.elabType(b.ty, new Map()) : null;
      this.scope.vals.set(b.name, { kind: 'exn', name: b.name, scheme: argTy ? tfn(argTy, tExn) : tExn, hasArg: !!argTy });
      this.echo.push({ kind: 'exception', name: b.name, ty: argTy });
      binds.push({ name: b.name, hasArg: !!argTy });
    }
    return { d: 'exception', binds };
  }

  localDec(d) {
    const saved = this.scope;
    const savedEcho = this.echo;
    const outer = saved;
    const headScope = outer.child();
    this.scope = headScope;
    this.echo = [];
    let head;
    let body;
    const bodyScope = headScope.child();
    try {
      head = [];
      for (const x of d.head) head.push(...this.dec(x));
      this.scope = bodyScope;
      this.echo = savedEcho;
      body = [];
      for (const x of d.body) body.push(...this.dec(x));
    } finally {
      this.scope = saved;
      this.echo = savedEcho;
    }
    bodyScope.mergeInto(saved); // only the body's bindings escape
    return { d: 'local', head, body };
  }
}

Object.assign(Elaborator.prototype, moduleMethods);
