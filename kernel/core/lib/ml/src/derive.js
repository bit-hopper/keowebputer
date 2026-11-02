// Derived forms (MLspec.md section 5.3, "Derived forms"): rewrites the parser's surface syntax into the smaller
// core the checker and the machine work on. Pure: the parsed tree is never modified, and nodes with nothing to
// rewrite (patterns, types, signatures) are shared with the result.
//
//   const core = derive(item);       // one top-level item from Parser#nextItem
//
// Rewrites (each result node carries `derived: '<form>'` so a message can still talk about the form the reader wrote):
//   case e of m              app{fn: fn{match: m, origin:{kind:'case'}}, arg: e}                  derived 'case'
//   (e1; e2; e3)             app{fn: fn{_ => (e2; e3)}, arg: e1}  (the Definition's rewrite)       derived 'seq'
//   a andalso b              if a then b else false                                                derived 'andalso'
//   a orelse b               if a then true else b                                                 derived 'orelse'
//   fun f p = e | f q = e'   val rec f = fn match  (one argument), or, for several arguments,
//                            fn $1 => fn $2 => (fn (p1,p2) => e | (q1,q2) => e')($1,$2)           derived 'fun'
//                            the binding pattern is `pid` with forceVar, since a function name is never a constructor;
//                            `fun f x : t = e` types the body: `(e : t)`.
//   functor F(specs) :> S = b   functor F($param : sig specs end) = let open $param in (b :> S) end  (the Definition's
//                            rewrite; the ascription moves inside so it can mention the components, e.g. a_N.number)
//   functor F(X : S) :> R = b   functor F(X : S) = (b :> R)
//   structure X :> S = b     structure X = (b :> S)
//   F(structure a = A ...)   F(struct structure a = A ... end);   F()  F(struct end)
//
// What is left is the core: expressions int var tuple app typed if fn let raise handle; items val (every binding
// carries `rec`) datatype type exception local signature structure functor expstmt pragma bad; strexps struct strid
// apply ascribe letstr; decs also include `open{strid}` (only ever produced here, for functor parameter specs).
// `fn` nodes carry `origin: {kind: 'fn'|'case'|'fun'|'seq', name?}` so the pattern checker can word its warnings.
// A `var` with `basis: true` (the `true`/`false` an andalso/orelse expands to) means the initial basis's binding,
// whatever the program has defined under that name since.
//
// Fresh names are `$1`, `$2`, ...: no source identifier can start with `$`, so they cannot clash with a program's.
import { MLError } from './errors.js';

const internal = (message, where) => new MLError('internal', message, where);

class Deriver {
  constructor() { this.counter = 0; }

  fresh() { return '$' + (++this.counter); }

  // ---- expressions ----

  exp(e) {
    switch (e.kind) {
      case 'int': case 'var': case 'string': case 'char':
        return e;
      case 'tuple': case 'list': // (a list literal is checked as it stands, so its messages talk about the elements)
        return { ...e, items: e.items.map((x) => this.exp(x)) };
      case 'app':
        return { ...e, fn: this.exp(e.fn), arg: this.exp(e.arg) };
      case 'typed':
        return { ...e, exp: this.exp(e.exp) };
      case 'raise':
        return { ...e, exp: this.exp(e.exp) };
      case 'if':
        return { ...e, cond: this.exp(e.cond), then: this.exp(e.then), else: this.exp(e.else) };
      case 'fn':
        return { ...e, match: this.match(e.match), origin: { kind: 'fn' } };
      case 'handle':
        return { ...e, exp: this.exp(e.exp), match: this.match(e.match) };
      case 'let':
        return { ...e, decs: e.decs.map((d) => this.dec(d)), body: this.exp(e.body) };
      case 'case':
        return {
          kind: 'app', loc: e.loc, derived: 'case',
          fn: { kind: 'fn', loc: e.loc, match: this.match(e.match), origin: { kind: 'case' } },
          arg: this.exp(e.exp),
        };
      case 'seq':
        return this.seq(e.exps, e.loc);
      case 'andalso':
        return {
          kind: 'if', loc: e.loc, derived: 'andalso',
          cond: this.exp(e.left), then: this.exp(e.right), else: this.bool('false', e.loc),
        };
      case 'orelse':
        return {
          kind: 'if', loc: e.loc, derived: 'orelse',
          cond: this.exp(e.left), then: this.bool('true', e.loc), else: this.exp(e.right),
        };
      default:
        throw internal('derive: unknown expression kind ' + e.kind, e.loc);
    }
  }

  bool(name, loc) { return { kind: 'var', name, qual: null, basis: true, loc }; }

  // (e1; e2; ...; en) is (fn _ => (e2; ...; en)) e1
  seq(exps, loc) {
    if (exps.length === 1) return this.exp(exps[0]);
    const rest = this.seq(exps.slice(1), loc);
    return {
      kind: 'app', loc, derived: 'seq',
      fn: { kind: 'fn', loc, match: [{ pat: { kind: 'wild', loc }, exp: rest }], origin: { kind: 'seq' } },
      arg: this.exp(exps[0]),
    };
  }

  match(rules) {
    return rules.map((r) => ({ ...r, exp: this.exp(r.exp) }));
  }

  // ---- declarations ----

  dec(d) {
    switch (d.kind) {
      case 'val':
        return { ...d, binds: d.binds.map((b) => ({ ...b, exp: this.exp(b.exp) })) };
      case 'fun':
        return this.fun(d);
      case 'datatype': case 'type': case 'exception': case 'signature':
        return d;
      case 'local':
        return { ...d, head: d.head.map((x) => this.dec(x)), body: d.body.map((x) => this.dec(x)) };
      case 'structure':
        return { ...d, binds: d.binds.map((b) => this.structureBind(b)) };
      case 'functor':
        return this.functor(d);
      default:
        throw internal('derive: unknown declaration kind ' + d.kind, d.loc);
    }
  }

  // fun f ... and g ...   ==>   val rec f = ... and g = ...
  fun(d) {
    const binds = d.binds.map((b) => ({
      rec: true,
      pat: { kind: 'pid', name: b.name, qual: null, forceVar: true, loc: b.loc },
      exp: this.funBody(b),
    }));
    return { kind: 'val', loc: d.loc, derived: 'fun', binds };
  }

  funBody(b) {
    const arity = b.clauses[0].pats.length;
    const origin = { kind: 'fun', name: b.name };
    const body = (c) => (c.resultTy ? { kind: 'typed', exp: this.exp(c.exp), ty: c.resultTy, loc: c.exp.loc } : this.exp(c.exp));
    if (arity === 1) {
      return { kind: 'fn', loc: b.loc, derived: 'fun', origin, match: b.clauses.map((c) => ({ pat: c.pats[0], exp: body(c) })) };
    }
    const vars = [];
    for (let i = 0; i < arity; i++) vars.push(this.fresh());
    const loc = b.loc;
    // The clauses are matched together, as one tuple, against all the arguments at once: a partial application
    // does no matching, exactly as with the curried function the clauses denote.
    let result = {
      kind: 'app', loc, derived: 'fun',
      fn: {
        kind: 'fn', loc, origin,
        match: b.clauses.map((c) => ({ pat: { kind: 'ptuple', items: c.pats, loc: c.pats[0].loc }, exp: body(c) })),
      },
      arg: { kind: 'tuple', loc, items: vars.map((v) => ({ kind: 'var', name: v, qual: null, loc })) },
    };
    for (let i = arity - 1; i >= 0; i--) {
      result = {
        kind: 'fn', loc, derived: 'fun', origin: { kind: 'fun', name: b.name, curried: true },
        match: [{ pat: { kind: 'pid', name: vars[i], qual: null, forceVar: true, loc }, exp: result }],
      };
    }
    return result;
  }

  // ---- modules ----

  // structure X :> S = b   ==>   structure X = (b :> S)
  structureBind(b) {
    const out = { name: b.name, body: this.str(b.body) };
    if (b.ascription) out.body = this.ascribe(out.body, b.ascription, b.body.loc);
    if (b.loc) out.loc = b.loc;
    return out;
  }

  ascribe(str, ascription, loc) {
    return { kind: 'ascribe', loc, str, sig: ascription.sig, opaque: ascription.opaque, derived: 'ascription' };
  }

  functor(d) {
    let body = this.str(d.body);
    if (d.param.kind === 'named') {
      if (d.ascription) body = this.ascribe(body, d.ascription, d.body.loc);
      return { kind: 'functor', loc: d.loc, name: d.name, param: d.param, body };
    }
    // Parameter given as bare specs: a functor over one structure whose components are those specs.
    const strid = '$param';
    const specs = d.param.specs;
    if (d.ascription) body = this.ascribe(body, d.ascription, d.body.loc);
    if (specs.length > 0) {
      body = { kind: 'letstr', loc: d.body.loc, derived: 'functor', decs: [{ kind: 'open', strid, loc: d.param.loc }], body };
    }
    const param = {
      kind: 'named', strid, loc: d.param.loc, derived: 'functor',
      sig: { kind: 'sig', specs, loc: d.param.loc },
    };
    return { kind: 'functor', loc: d.loc, name: d.name, param, body };
  }

  str(s) {
    switch (s.kind) {
      case 'strid':
        return s;
      case 'struct':
        return { ...s, decs: s.decs.map((d) => this.dec(d)) };
      case 'letstr':
        return { ...s, decs: s.decs.map((d) => this.dec(d)), body: this.str(s.body) };
      case 'ascribe':
        return { ...s, str: this.str(s.str) };
      case 'apply': {
        // F(structure a = A  structure b = B) and F() are F(struct ... end)
        const arg = s.arg.kind === 'decs'
          ? { kind: 'struct', loc: s.arg.loc, derived: 'functor', decs: s.arg.decs.map((d) => this.dec(d)) }
          : this.str(s.arg);
        return { ...s, arg };
      }
      default:
        throw internal('derive: unknown structure expression kind ' + s.kind, s.loc);
    }
  }

  item(it) {
    switch (it.kind) {
      case 'pragma': case 'bad':
        return it;
      case 'expstmt':
        return { ...it, exp: this.exp(it.exp) };
      default: {
        const d = this.dec(it);
        if (d === it) return it;
        // the item-level fields the parser attached (text, expectRejected) belong to the item, not the rewrite
        const out = { ...d };
        if (it.text !== undefined) out.text = it.text;
        if (it.expectRejected) out.expectRejected = true;
        return out;
      }
    }
  }
}

// Expand one top-level item (or, for tests, any expression or declaration via deriveExp / deriveDec).
export function derive(item) { return new Deriver().item(item); }
export function deriveExp(e) { return new Deriver().exp(e); }
export function deriveDec(d) { return new Deriver().dec(d); }
