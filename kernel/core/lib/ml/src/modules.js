// Modules (MLspec.md section 7): the static semantics of signatures, structures and functors, installed on the Elaborator
// (infer.js) as extra methods. Pure helpers first, then the methods.
//
// Vocabulary. A *structure's environment* is a parentless `Scope` (vals, types, strs). A *signature* (class Sig) is such an
// environment plus `flex`, the placeholder TyNames its `type t` specs stand for, and `sharing`, pairs of types that must be
// equal. A *realisation* (class Real) maps TyNames to types: it is how a match is recorded (placeholder -> the structure's
// type), how an opaque ascription hides a type (placeholder -> a fresh abstract name), and how a functor's result is
// instantiated (the parameter's rigid names -> the argument's types, its generated names -> fresh copies).
import { MLError } from './errors.js';
import { unify, UnifyFailure } from './unify.js';
import {
  Scope, TVar, TyName, prune, tcon, tfn, tExn, substitute, instantiate, typeToString, currentStamp,
} from './types.js';

export const sigError = (message, where) => new MLError('signature', message, where && (where.loc || where));
const nonsense = (message, where) => new MLError('nonsense', message, where && (where.loc || where));

const isEqName = (n) => n.startsWith("''");

// ---- realisations ------------------------------------------------------------------------------------------------

export class Real {
  constructor() {
    this.map = new Map();     // TyName -> {to: TyName} | {params: [TVar], body: Type}
    this.conMap = new Map();  // ConInfo -> ConInfo       (cloned datatypes)
  }
}

export function applyReal(t, real) {
  t = prune(t);
  switch (t.tag) {
    case 'fn': {
      const from = applyReal(t.from, real);
      const to = applyReal(t.to, real);
      return from === t.from && to === t.to ? t : tfn(from, to);
    }
    case 'tuple': return { tag: 'tuple', items: t.items.map((x) => applyReal(x, real)) };
    case 'con': {
      const args = t.args.map((x) => applyReal(x, real));
      const m = real.map.get(t.name);
      if (!m) return args.length === 0 ? t : tcon(t.name, args);
      if (m.to) return tcon(m.to, args);
      return substitute(m.body, m.params, args);
    }
    default: return t;
  }
}

function realTypeEntry(e, real) {
  if (e.kind === 'tyname') {
    const m = real.map.get(e.tyname);
    if (!m) return e;
    return m.to ? { kind: 'tyname', tyname: m.to } : { kind: 'abbrev', params: m.params, body: m.body };
  }
  return { kind: 'abbrev', params: e.params, body: applyReal(e.body, real) };
}

function realVal(info, real) {
  if (info.kind === 'con') return real.conMap.get(info) || info;
  if (info.kind === 'prim') return info;
  const scheme = applyReal(info.scheme, real);
  return scheme === info.scheme ? info : { ...info, scheme };
}

// A copy of the environment with the realisation applied everywhere.
export function realEnv(env, real) {
  const out = new Scope();
  for (const [name, e] of env.types) out.types.set(name, realTypeEntry(e, real));
  for (const [name, info] of env.vals) out.vals.set(name, realVal(info, real));
  for (const [name, s] of env.strs) out.strs.set(name, { ...s, env: realEnv(s.env, real) });
  return out;
}

// Every TyName with stamp >= `since` that the environment mentions (they are the names a functor body generated).
export function generatedNames(env, since, out = new Set()) {
  const visitName = (tn) => {
    if (tn.stamp < since || out.has(tn)) return;
    out.add(tn);
    for (const c of tn.cons) if (c.ty) visitType(c.ty);
  };
  const visitType = (t) => {
    t = prune(t);
    if (t.tag === 'fn') { visitType(t.from); visitType(t.to); } else if (t.tag === 'tuple') t.items.forEach(visitType);
    else if (t.tag === 'con') { visitName(t.name); t.args.forEach(visitType); }
  };
  for (const e of env.types.values()) {
    if (e.kind === 'tyname') visitName(e.tyname); else visitType(e.body);
  }
  for (const info of env.vals.values()) if (info.kind !== 'prim') visitType(info.scheme);
  for (const s of env.strs.values()) generatedNames(s.env, since, out);
  return out;
}

// Fresh copies of `names` (datatypes keep their constructors, retargeted), recorded in `real`.
export function cloneNames(names, real) {
  const clones = new Map();
  for (const tn of names) {
    const c = new TyName(tn.name, tn.arity, tn.admitsEq);
    c.isDatatype = tn.isDatatype;
    c.params = tn.params;
    c.path = tn.path;
    c.abstract = tn.abstract;
    clones.set(tn, c);
    real.map.set(tn, { to: c });
  }
  for (const [tn, c] of clones) {
    for (const con of tn.cons) {
      const info = { ...con.info, tyname: c, scheme: applyReal(con.info.scheme, real) };
      c.cons.push({ name: con.name, ty: con.ty ? applyReal(con.ty, real) : null, info });
      real.conMap.set(con.info, info);
    }
  }
}

// Give the types a structure introduced a path for messages: IntStruct.number. Only names made since `since` and not yet named.
export function assignPaths(env, prefix, since) {
  for (const [name, e] of env.types) {
    if (e.kind === 'tyname' && e.tyname.stamp >= since && !e.tyname.path) e.tyname.path = prefix.concat(name);
  }
  for (const [name, s] of env.strs) assignPaths(s.env, prefix.concat(name), since);
}

// ---- type comparison ---------------------------------------------------------------------------------------------

export function typesEqual(a, b) {
  a = prune(a);
  b = prune(b);
  if (a === b) return true;
  if (a.tag !== b.tag) return false;
  switch (a.tag) {
    case 'fn': return typesEqual(a.from, b.from) && typesEqual(a.to, b.to);
    case 'tuple': return a.items.length === b.items.length && a.items.every((x, i) => typesEqual(x, b.items[i]));
    case 'con': return a.name === b.name && a.args.every((x, i) => typesEqual(x, b.args[i]));
    default: return false;
  }
}

function skolemize(t, map = new Map()) {
  t = prune(t);
  switch (t.tag) {
    case 'var': {
      if (!t.generic) return t;
      let v = map.get(t);
      if (!v) { v = new TVar(1000000, t.eq); v.rigid = true; map.set(t, v); }
      return v;
    }
    case 'fn': return tfn(skolemize(t.from, map), skolemize(t.to, map));
    case 'tuple': return { tag: 'tuple', items: t.items.map((x) => skolemize(x, map)) };
    case 'con': return t.args.length === 0 ? t : tcon(t.name, t.args.map((x) => skolemize(x, map)));
    default: return t;
  }
}

// Is `general` (a scheme) at least as general as `spec` (a scheme)?
function subsumes(general, spec) {
  const g = instantiate(general, 1);
  const s = skolemize(spec);
  try { unify(g, s); return true; } catch (e) { if (e instanceof UnifyFailure) return false; throw e; }
}

// The first abstract type (made by opaque ascription, or a functor parameter's) a type mentions, or null.
export function firstAbstract(t) {
  t = prune(t);
  switch (t.tag) {
    case 'fn': return firstAbstract(t.from) || firstAbstract(t.to);
    case 'tuple': for (const x of t.items) { const a = firstAbstract(x); if (a) return a; } return null;
    case 'con': if (t.name.abstract) return t.name; for (const x of t.args) { const a = firstAbstract(x); if (a) return a; } return null;
    default: return null;
  }
}

// ---- signatures --------------------------------------------------------------------------------------------------

export class Sig {
  constructor(env, flex, sharing, name = null) {
    this.env = env;         // Scope
    this.flex = flex;       // [TyName] placeholders
    this.sharing = sharing; // [[Type, Type]]
    this.name = name;
  }
}

// A use of a named signature gets its own placeholders, so two `structure a : N` specs have different `number`s.
export function freshSig(sig) {
  const real = new Real();
  const flex = sig.flex.map((ph) => {
    const n = new TyName(ph.name, ph.arity, false);
    n.flex = true;
    real.map.set(ph, { to: n });
    return n;
  });
  const sharing = sig.sharing.map(([a, b]) => [applyReal(a, real), applyReal(b, real)]);
  return new Sig(realEnv(sig.env, real), flex, sharing, sig.name);
}

// Placeholders that a `sharing type` constraint ties together, as classes.
function sharingClasses(sig) {
  const parent = new Map(sig.flex.map((p) => [p, p]));
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  for (const [a, b] of sig.sharing) {
    const ta = prune(a);
    const tb = prune(b);
    if (ta.tag === 'con' && tb.tag === 'con' && parent.has(ta.name) && parent.has(tb.name)) parent.set(find(ta.name), find(tb.name));
  }
  return find;
}

// The signature's environment with each placeholder replaced by a fresh name that is `rigid` (a functor's parameter: nothing is
// known about it) or the same kind of abstract name an opaque ascription makes; placeholders tied by `sharing` get one name.
export function abstractInstance(sig) {
  const find = sharingClasses(sig);
  const names = new Map();
  const real = new Real();
  for (const ph of sig.flex) {
    const rep = find(ph);
    if (!names.has(rep)) {
      const n = new TyName(rep.name, rep.arity, false);
      n.abstract = true;
      names.set(rep, n);
    }
    real.map.set(ph, { to: names.get(rep) });
  }
  return { real, env: realEnv(sig.env, real) };
}

// What a run-time structure keeps when it is thinned to a signature: the value names, and for each substructure the same.
export function thinSpec(env) {
  const vals = [];
  for (const [name, info] of env.vals) if (info.kind === 'var' || info.kind === 'exn') vals.push(name);
  const strs = {};
  for (const [name, s] of env.strs) strs[name] = thinSpec(s.env);
  return { vals, strs };
}

// ---- matching a structure against a signature ------------------------------------------------------------------

const pathText = (path, name) => path.concat(name).join('.');

function mapFlex(strEnv, sigEnv, flexSet, real, path, where) {
  for (const [name, e] of sigEnv.types) {
    if (e.kind !== 'tyname' || !flexSet.has(e.tyname)) continue;
    const se = strEnv.types.get(name);
    if (!se) throw sigError('the structure has no type ' + pathText(path, name) + ', which the signature asks for', where);
    const arity = se.kind === 'tyname' ? se.tyname.arity : se.params.length;
    if (arity !== e.tyname.arity) {
      throw sigError('the type ' + pathText(path, name) + ' takes ' + arity + ' argument' + (arity === 1 ? '' : 's') +
        ' in the structure, but ' + e.tyname.arity + ' in the signature', where);
    }
    real.map.set(e.tyname, se.kind === 'tyname' ? { to: se.tyname } : { params: se.params, body: se.body });
  }
  for (const [name, s] of sigEnv.strs) {
    const ss = strEnv.strs.get(name);
    if (!ss) throw sigError('the structure has no substructure ' + pathText(path, name) + ', which the signature asks for', where);
    mapFlex(ss.env, s.env, flexSet, real, path.concat(name), where);
  }
}

function checkEnv(strEnv, sigEnv, real, style, path, where) {
  const show = (t) => typeToString(t, style, new Map());
  for (const [name, e] of sigEnv.types) {
    if (e.kind !== 'abbrev') continue;
    const se = strEnv.types.get(name);
    if (!se) throw sigError('the structure has no type ' + pathText(path, name) + ', which the signature defines', where);
    const arity = se.kind === 'tyname' ? se.tyname.arity : se.params.length;
    if (arity !== e.params.length) throw sigError('type ' + pathText(path, name) + ' does not match definitional specification', where);
    const rigid = e.params.map(() => { const v = new TVar(1000000); v.rigid = true; return v; });
    const want = applyReal(substitute(e.body, e.params, rigid), real);
    const have = se.kind === 'tyname' ? tcon(se.tyname, rigid) : substitute(se.body, se.params, rigid);
    if (!typesEqual(want, have)) {
      throw sigError('type ' + pathText(path, name) + ' does not match definitional specification: the signature says it is ' +
        show(want) + ', but the structure has ' + show(have) +
        (show(want) === show(have) ? ' (two different types that happen to have the same name)' : ''), where);
    }
  }
  for (const [name, info] of sigEnv.vals) {
    const st = strEnv.vals.get(name);
    if (!st) throw sigError('the structure has no ' + (info.kind === 'exn' ? 'exception ' : 'value ') + pathText(path, name) + ', which the signature asks for', where);
    const want = applyReal(info.scheme, real);
    if (info.kind === 'exn') {
      if (st.kind !== 'exn') throw sigError(pathText(path, name) + ' is not an exception in the structure', where);
      if (!!st.hasArg !== !!info.hasArg || !typesEqual(st.scheme, want)) {
        throw sigError('the exception ' + pathText(path, name) + ' has a different argument type in the structure than in the signature', where);
      }
    } else if (!subsumes(st.scheme, want)) {
      throw sigError(pathText(path, name) + ' has type ' + show(st.scheme) + ' in the structure, which is not as general as the signature\'s ' + show(want), where);
    }
  }
  for (const [name, s] of sigEnv.strs) checkEnv(strEnv.strs.get(name).env, s.env, real, style, path.concat(name), where);
}

// Match `strEnv` against `sig` (an instance made for this one use); returns the realisation of the sig's placeholders.
export function matchSig(strEnv, sig, style, where) {
  const real = new Real();
  const flexSet = new Set(sig.flex);
  mapFlex(strEnv, sig.env, flexSet, real, [], where);
  checkEnv(strEnv, sig.env, real, style, [], where);
  for (const [a, b] of sig.sharing) {
    const ra = applyReal(a, real);
    const rb = applyReal(b, real);
    if (!typesEqual(ra, rb)) {
      throw sigError('type sharing violation: ' + typeToString(ra, style, new Map()) + ' # ' + typeToString(rb, style, new Map()) +
        ' (the signature says these must be the same type)', where);
    }
  }
  return real;
}

// ---- the Elaborator's module methods -------------------------------------------------------------------------------

function collectTyvars(node, out = new Set()) {
  if (Array.isArray(node)) { node.forEach((x) => collectTyvars(x, out)); return out; }
  if (node === null || typeof node !== 'object') return out;
  if (node.kind === 'tyvar') out.add(node.name);
  for (const k of Object.keys(node)) if (k !== 'loc') collectTyvars(node[k], out);
  return out;
}

const parentless = (scope) => {
  const env = new Scope();
  env.vals = new Map(scope.vals);
  env.types = new Map(scope.types);
  env.strs = new Map(scope.strs);
  return env;
};

export const moduleMethods = {
  // The structure environment a path of structure names leads to.
  qualEnv(path, node) {
    const first = this.scope.lookupStr(path[0]);
    if (!first) throw sigError('the structure ' + path[0] + ' is not defined', node);
    let env = first.env;
    for (let i = 1; i < path.length; i++) {
      const next = env.strs.get(path[i]);
      if (!next) throw sigError(path.slice(0, i).join('.') + ' has no substructure ' + path[i], node);
      env = next.env;
    }
    return env;
  },

  lookupQualVal(node) {
    const env = this.qualEnv(node.qual, node);
    const info = env.vals.get(node.name);
    if (!info) {
      throw sigError(node.qual.join('.') + ' has no component ' + node.name + ' (a signature may be hiding it)', node);
    }
    return info;
  },

  lookupQualType(node) {
    const env = this.qualEnv(node.qual, node);
    const entry = env.types.get(node.name);
    if (!entry) throw sigError(node.qual.join('.') + ' has no type ' + node.name, node);
    return entry;
  },

  // ---- signature expressions ----

  sigexp(s) {
    switch (s.kind) {
      case 'sigid': {
        const sig = this.scope.lookupSig(s.name);
        if (!sig) throw sigError('the signature ' + s.name + ' is not defined', s);
        return freshSig(sig);
      }
      case 'sig': return this.sigBody(s);
      case 'where': return this.sigWhere(s);
      default: throw new MLError('internal', 'sigexp: ' + s.kind, s.loc);
    }
  },

  sigBody(s) {
    const saved = this.scope;
    const sc = saved.child();
    this.scope = sc;
    const flex = [];
    const sharing = [];
    try {
      for (const spec of s.specs) {
        switch (spec.kind) {
          case 'sigtype': {
            const ph = new TyName(spec.name, spec.tyvars.length, false);
            ph.flex = true;
            sc.types.set(spec.name, { kind: 'tyname', tyname: ph });
            flex.push(ph);
            break;
          }
          case 'sigval': {
            const tv = new Map();
            for (const n of collectTyvars(spec.ty)) { const v = new TVar(1, isEqName(n)); v.generic = true; tv.set(n, v); }
            sc.vals.set(spec.name, { kind: 'var', scheme: this.elabType(spec.ty, tv) });
            break;
          }
          case 'sigexn': {
            const arg = spec.ty ? this.elabType(spec.ty, new Map()) : null;
            sc.vals.set(spec.name, { kind: 'exn', name: spec.name, scheme: arg ? tfn(arg, tExn) : tExn, hasArg: !!arg });
            break;
          }
          case 'sigstruct': {
            const sub = this.sigexp(spec.sig);
            sc.strs.set(spec.name, { env: sub.env, sigName: sub.name });
            flex.push(...sub.flex);
            sharing.push(...sub.sharing);
            break;
          }
          case 'sharing': {
            const types = spec.tycons.map((tc) => {
              const entry = tc.qual ? this.lookupQualType(tc) : this.scope.lookupType(tc.name);
              if (!entry) throw sigError('the type ' + tc.name + ' is not defined here', spec);
              if (entry.kind !== 'tyname') throw sigError('sharing needs type names, but ' + tc.name + ' is an abbreviation', spec);
              return tcon(entry.tyname, []);
            });
            for (let i = 1; i < types.length; i++) sharing.push([types[0], types[i]]);
            break;
          }
          default: throw new MLError('internal', 'spec: ' + spec.kind, spec.loc);
        }
      }
    } finally {
      this.scope = saved;
    }
    return new Sig(parentless(sc), flex, sharing);
  },

  // sig where type [tyvars] path = ty
  sigWhere(s) {
    const base = this.sigexp(s.sig);
    let env = base.env;
    for (const q of s.tycon.qual || []) {
      const next = env.strs.get(q);
      if (!next) throw sigError('the signature has no substructure ' + q, s);
      env = next.env;
    }
    const entry = env.types.get(s.tycon.name);
    if (!entry || entry.kind !== 'tyname' || !base.flex.includes(entry.tyname)) {
      throw sigError('where type: ' + (s.tycon.qual || []).concat(s.tycon.name).join('.') + ' is not a type the signature leaves open', s);
    }
    const ph = entry.tyname;
    const params = s.tyvars.map((n) => new TVar(0, isEqName(n)));
    if (params.length !== ph.arity) throw sigError('where type: ' + s.tycon.name + ' takes ' + ph.arity + ' type argument' + (ph.arity === 1 ? '' : 's'), s);
    const body = this.elabType(s.ty, new Map(s.tyvars.map((n, i) => [n, params[i]])));
    const real = new Real();
    real.map.set(ph, { params, body });
    return new Sig(
      realEnv(base.env, real),
      base.flex.filter((p) => p !== ph),
      base.sharing.map(([a, b]) => [applyReal(a, real), applyReal(b, real)]),
      null,
    );
  },

  // ---- structure expressions ----

  // -> { env, ir, sigName }
  strexp(s) {
    switch (s.kind) {
      case 'strid': {
        const path = (s.qual || []).concat(s.name);
        const env = this.qualEnv(path, s);
        const bound = this.scope.lookupStr(path[0]);
        return { env, ir: { s: 'path', path }, sigName: path.length === 1 ? bound.sigName : null };
      }
      case 'struct': return this.structBody(s);
      case 'letstr': {
        const saved = this.scope;
        const savedEcho = this.echo;
        this.scope = saved.child();
        this.echo = [];
        try {
          const decs = [];
          for (const d of s.decs) decs.push(...this.dec(d));
          const body = this.strexp(s.body);
          return { env: body.env, ir: { s: 'let', decs, body: body.ir }, sigName: body.sigName };
        } finally {
          this.scope = saved;
          this.echo = savedEcho;
        }
      }
      case 'apply': {
        const fn = this.scope.lookupFun(s.fun);
        if (!fn) throw sigError('the functor ' + s.fun + ' is not defined', s);
        const arg = this.strexp(s.arg);
        return { env: this.applyFunctor(fn, arg.env, s), ir: { s: 'apply', fun: s.fun, arg: arg.ir }, sigName: fn.resultSigName };
      }
      case 'ascribe': {
        const inner = this.strexp(s.str);
        const sig = this.sigexp(s.sig);
        const real = matchSig(inner.env, sig, this.style, s);
        let env;
        if (s.opaque) env = abstractInstance(sig).env;
        else env = realEnv(sig.env, real);
        return { env, ir: { s: 'thin', str: inner.ir, spec: thinSpec(sig.env) }, sigName: sig.name };
      }
      default: throw new MLError('internal', 'strexp: ' + s.kind, s.loc);
    }
  },

  structBody(s) {
    const saved = this.scope;
    const savedEcho = this.echo;
    this.scope = saved.child();
    this.echo = [];
    let inner;
    const decs = [];
    try {
      for (const d of s.decs) decs.push(...this.dec(d));
      inner = this.scope;
    } finally {
      this.scope = saved;
      this.echo = savedEcho;
    }
    const env = parentless(inner);
    const vals = [];
    const cons = [];
    for (const [name, info] of env.vals) {
      if (info.kind === 'var' || info.kind === 'exn') vals.push(name);
      else if (info.kind === 'con') cons.push({ name, con: info });
    }
    return { env, ir: { s: 'struct', decs, vals, cons, strs: [...env.strs.keys()] }, sigName: null };
  },

  // ---- declarations ----

  signatureDec(d) {
    for (const b of d.binds) {
      const sig = this.sigexp(b.sig);
      sig.name = b.name;
      this.scope.sigs.set(b.name, sig);
      this.echo.push({ kind: 'signature', name: b.name, sig });
    }
    return [];
  },

  structureDec(d) {
    const made = d.binds.map((b) => {
      const since = currentStamp();
      const r = this.strexp(b.body);
      assignPaths(r.env, [b.name], since);
      return { b, r };
    });
    const binds = [];
    for (const { b, r } of made) {
      this.scope.strs.set(b.name, { env: r.env, sigName: r.sigName });
      this.echo.push({ kind: 'structure', name: b.name, env: r.env, sigName: r.sigName });
      binds.push({ name: b.name, str: r.ir });
    }
    return [{ d: 'structure', binds }];
  },

  functorDec(d) {
    if (d.param.kind !== 'named') throw new MLError('internal', 'functor parameter was not derived', d.loc);
    const sig = this.sigexp(d.param.sig);
    const since = currentStamp();
    const inst = abstractInstance(sig); // the parameter, as the body sees it: its types are rigid
    assignPaths(inst.env, d.param.derived ? [] : [d.param.strid], since);
    const wm = currentStamp();
    const saved = this.scope;
    const savedEcho = this.echo;
    this.scope = saved.child();
    this.scope.strs.set(d.param.strid, { env: inst.env, sigName: sig.name });
    this.echo = [];
    let body;
    try {
      body = this.strexp(d.body);
    } finally {
      this.scope = saved;
      this.echo = savedEcho;
    }
    const fn = {
      name: d.name, paramName: d.param.strid, derived: !!d.param.derived, sig, rigid: inst.real, wm, result: body.env, resultSigName: body.sigName,
    };
    this.scope.funs.set(d.name, fn);
    this.echo.push({ kind: 'functor', name: d.name, fn });
    return [{ d: 'functor', name: d.name, param: d.param.strid, body: body.ir }];
  },

  // F(arg): match the argument against the parameter signature, realise the rigid names, and freshen what the body generated.
  applyFunctor(fn, argEnv, where) {
    // (matched against the functor's own parameter signature, not a fresh copy: fn.rigid is keyed by its placeholders)
    const matched = matchSig(argEnv, fn.sig, this.style, where);
    const real = new Real();
    for (const [ph, m] of fn.rigid.map) {
      const to = matched.map.get(ph);
      if (to) real.map.set(m.to, to);
    }
    const generated = generatedNames(fn.result, fn.wm);
    for (const m of fn.rigid.map.values()) generated.delete(m.to);
    cloneNames(generated, real);
    return realEnv(fn.result, real);
  },

  openDec(d) {
    const env = this.qualEnv([d.strid], d);
    for (const [k, v] of env.vals) this.scope.vals.set(k, v);
    for (const [k, v] of env.types) this.scope.types.set(k, v);
    for (const [k, v] of env.strs) this.scope.strs.set(k, v);
    const vals = [];
    for (const [name, info] of env.vals) if (info.kind === 'var' || info.kind === 'exn') vals.push(name);
    return [{ d: 'open', path: [d.strid], vals, strs: [...env.strs.keys()] }];
  },
};

export { nonsense };
