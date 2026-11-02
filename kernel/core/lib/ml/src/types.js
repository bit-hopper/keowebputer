// Semantic types (MLspec.md section 6.3) and the static environment.
//
//   TVar    a unification variable: mutable `ref` (null while unbound), a `level` for let-generalisation, an `eq`
//           flag (''a), an `ord` flag (the variable of an overloaded comparison: it can only become int, string or char,
//           and defaults to int if nothing else decides; see `ORDERED`), `rigid` (a type variable written in an annotation: it unifies with nothing but itself, as
//           SML/NJ treats it), and `generic` (quantified: a scheme's own variables; `instantiate` replaces them).
//   TCon    {tag:'con', name: TyName, args}      a type name applied to its arguments
//   TFn     {tag:'fn', from, to}
//   TTuple  {tag:'tuple', items}                 unit is the empty tuple
//
// A type scheme is just a type whose quantified variables are marked `generic`.
//
// A TyName is a type's identity: two datatypes with the same name are different TyNames (datatypes are generative).
// For a datatype it also holds what the printer and the pattern checker need: `params` (its generic type variables)
// and `cons` (name, argument type or null, in declaration order).

let nextId = 1;

export class TVar {
  constructor(level, eq = false) {
    this.tag = 'var';
    this.id = nextId++;
    this.ref = null;
    this.level = level;
    this.eq = eq;
    this.ord = false;
    this.rigid = false;
    this.generic = false;
    this.name = null; // source name, for rigid variables written in an annotation
  }
}

let nextStamp = 1;
// The stamp the next TyName will get: everything created after this point has a stamp >= it (a functor's generated types).
export const currentStamp = () => nextStamp;

export class TyName {
  constructor(name, arity, admitsEq) {
    this.stamp = nextStamp++;
    this.name = name;
    this.arity = arity;
    this.admitsEq = admitsEq;
    this.params = [];
    this.cons = []; // datatypes: [{name, ty, info}]
    this.isDatatype = false;
    // modules (MLspec.md section 7)
    this.path = null;       // ['IntStruct', 'number']: where the type lives, for printing; null for a top-level type
    this.abstract = false;  // made by opaque ascription or standing for a functor parameter's type: nothing is known about it
    this.flex = false;      // a signature's `type t` placeholder
  }
}

// How a type constructor reads in a message: its path if it lives in a structure.
export const tyNameText = (tn) => (tn.path ? tn.path.join('.') : tn.name);

export const tcon = (name, args = []) => ({ tag: 'con', name, args });
export const tfn = (from, to) => ({ tag: 'fn', from, to });
export const ttuple = (items) => ({ tag: 'tuple', items });

// ---- the built-in type names ---------------------------------------------------------------------------------

export const INT = new TyName('int', 0, true);
export const EXN = new TyName('exn', 0, false);
export const BOOL = new TyName('bool', 0, true);
BOOL.isDatatype = true;

// Phase 5a: string and char (equality types), and the two built-in datatypes, `'a list` and `'a option`. Their constructors are
// filled in by basis.js (once per process, like bool's), so a value built by the machine and a pattern written by a program
// always share the same ConInfos.
export const STRING = new TyName('string', 0, true);
export const CHAR = new TyName('char', 0, true);
export const LIST = new TyName('list', 1, true);
LIST.isDatatype = true;
export const OPTION = new TyName('option', 1, true);
OPTION.isDatatype = true;

// The types `<`, `>`, `<=` and `>=` work on (SML overloads them on real and word too; there are none here).
export const ORDERED = new Set([INT, STRING, CHAR]);

export const tInt = tcon(INT);
export const tBool = tcon(BOOL);
export const tExn = tcon(EXN);
export const tUnit = ttuple([]);
export const tString = tcon(STRING);
export const tChar = tcon(CHAR);
export const tList = (t) => tcon(LIST, [t]);
export const tOption = (t) => tcon(OPTION, [t]);

// ---- inspecting types ----------------------------------------------------------------------------------------

export function prune(t) {
  while (t.tag === 'var' && t.ref !== null) t = t.ref;
  return t;
}

// Does the type admit equality? (Flexible variables are assumed to: unification will mark them.)
export function admitsEq(t) {
  t = prune(t);
  switch (t.tag) {
    case 'var': return t.rigid ? t.eq : true;
    case 'fn': return false;
    case 'tuple': return t.items.every(admitsEq);
    case 'con': return t.name.admitsEq && t.args.every(admitsEq);
    default: return false;
  }
}

export function occurs(v, t) {
  t = prune(t);
  switch (t.tag) {
    case 'var': return t === v;
    case 'fn': return occurs(v, t.from) || occurs(v, t.to);
    case 'tuple': return t.items.some((x) => occurs(v, x));
    case 'con': return t.args.some((x) => occurs(v, x));
    default: return false;
  }
}

// Free (unbound, non-generic) variables of a type, in order of first appearance.
export function freeVars(t, out = []) {
  t = prune(t);
  switch (t.tag) {
    case 'var': if (!out.includes(t)) out.push(t); break;
    case 'fn': freeVars(t.from, out); freeVars(t.to, out); break;
    case 'tuple': t.items.forEach((x) => freeVars(x, out)); break;
    case 'con': t.args.forEach((x) => freeVars(x, out)); break;
    default: break;
  }
  return out;
}

// ---- schemes: generalise and instantiate -----------------------------------------------------------------------

// Mark every variable of `t` deeper than `level` as generic. No value restriction: the language has no ref, so every
// binding generalises (MLspec.md section 5.4).
export function generalize(t, level) {
  t = prune(t);
  switch (t.tag) {
    case 'var':
      // (an overloaded comparison's variable is never quantified: it stays with the enclosing declaration until it is decided
      // or, at the top level, defaulted to int)
      if (t.level > level) { if (t.ord) t.level = level; else t.generic = true; }
      break;
    case 'fn': generalize(t.from, level); generalize(t.to, level); break;
    case 'tuple': t.items.forEach((x) => generalize(x, level)); break;
    case 'con': t.args.forEach((x) => generalize(x, level)); break;
    default: break;
  }
  return t;
}

// A fresh copy of a scheme with its generic variables replaced by new unification variables at `level`.
export function instantiate(t, level, map = new Map()) {
  t = prune(t);
  switch (t.tag) {
    case 'var': {
      if (!t.generic) return t;
      let v = map.get(t);
      if (!v) { v = new TVar(level, t.eq); v.ord = t.ord; map.set(t, v); }
      return v;
    }
    case 'fn': {
      const from = instantiate(t.from, level, map);
      const to = instantiate(t.to, level, map);
      return from === t.from && to === t.to ? t : tfn(from, to);
    }
    case 'tuple': return ttuple(t.items.map((x) => instantiate(x, level, map)));
    case 'con': return t.args.length === 0 ? t : tcon(t.name, t.args.map((x) => instantiate(x, level, map)));
    default: return t;
  }
}

// Substitute `vars[i] := args[i]` in `t` (type abbreviation expansion, datatype constructor types).
export function substitute(t, vars, args) {
  t = prune(t);
  switch (t.tag) {
    case 'var': { const i = vars.indexOf(t); return i >= 0 ? args[i] : t; }
    case 'fn': return tfn(substitute(t.from, vars, args), substitute(t.to, vars, args));
    case 'tuple': return ttuple(t.items.map((x) => substitute(x, vars, args)));
    case 'con': return t.args.length === 0 ? t : tcon(t.name, t.args.map((x) => substitute(x, vars, args)));
    default: return t;
  }
}

// ---- the static environment ------------------------------------------------------------------------------------

// A chain of scopes. An item is elaborated in a fresh child of the global scope and `mergeInto`-ed only on success, so a
// failed item changes nothing.
//   vals   name -> {kind:'var', scheme} | {kind:'con', name, scheme, tyname, hasArg, index}
//                 | {kind:'exn', name, scheme, hasArg} | {kind:'prim', name, scheme}
//   types  name -> {kind:'tyname', tyname} | {kind:'abbrev', params:[TVar], body}
export class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.vals = new Map();
    this.types = new Map();
    this.strs = new Map(); // name -> {env: Scope}      a structure's static environment (no parent)
    this.sigs = new Map(); // name -> Sig               see modules.js
    this.funs = new Map(); // name -> Functor           see modules.js
  }

  lookupStr(name) {
    for (let s = this; s; s = s.parent) if (s.strs.has(name)) return s.strs.get(name);
    return null;
  }

  lookupSig(name) {
    for (let s = this; s; s = s.parent) if (s.sigs.has(name)) return s.sigs.get(name);
    return null;
  }

  lookupFun(name) {
    for (let s = this; s; s = s.parent) if (s.funs.has(name)) return s.funs.get(name);
    return null;
  }

  lookupVal(name) {
    for (let s = this; s; s = s.parent) if (s.vals.has(name)) return s.vals.get(name);
    return null;
  }

  lookupType(name) {
    for (let s = this; s; s = s.parent) if (s.types.has(name)) return s.types.get(name);
    return null;
  }

  root() { let s = this; while (s.parent) s = s.parent; return s; }

  child() { return new Scope(this); }

  mergeInto(target) {
    for (const [k, v] of this.vals) target.vals.set(k, v);
    for (const [k, v] of this.types) target.types.set(k, v);
    for (const [k, v] of this.strs) target.strs.set(k, v);
    for (const [k, v] of this.sigs) target.sigs.set(k, v);
    for (const [k, v] of this.funs) target.funs.set(k, v);
  }
}

// ---- printing types --------------------------------------------------------------------------------------------

const GREEK = ['α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ'];

// style 'book': `(int * (int list)) -> int`, α β γ -- a compound operand of * or -> is always parenthesised, the way the
// book typesets its type boxes. style 'sml': SML precedence, 'a 'b.
// `names` (a Map) is shared between calls that should agree on variable names (one binding's whole type, say).
export function typeToString(t, style = 'book', names = new Map()) {
  const alphabet = style === 'book' ? GREEK : 'abcdefghijklmnopqrstuvwxyz'.split('');
  const varName = (v) => {
    if (!names.has(v)) {
      const n = names.autoCount || 0;
      names.autoCount = n + 1;
      names.set(v, alphabet[n % alphabet.length] + (n >= alphabet.length ? String(Math.floor(n / alphabet.length)) : ''));
    }
    return (v.eq ? "''" : (style === 'book' ? '' : "'")) + names.get(v);
  };

  const compound = (x) => {
    x = prune(x);
    return x.tag === 'fn' || (x.tag === 'tuple' && x.items.length > 1) || (x.tag === 'con' && x.args.length > 0);
  };

  const book = (x) => {
    x = prune(x);
    switch (x.tag) {
      case 'var': return varName(x);
      case 'fn': return operand(x.from) + ' -> ' + operand(x.to);
      case 'tuple': return x.items.length === 0 ? 'unit' : x.items.map(operand).join(' * ');
      case 'con':
        if (x.args.length === 0) return tyNameText(x.name);
        if (x.args.length === 1) return operand(x.args[0]) + ' ' + tyNameText(x.name);
        return '(' + x.args.map(book).join(', ') + ') ' + tyNameText(x.name);
      default: return '?';
    }
  };
  const operand = (x) => (compound(x) ? '(' + book(x) + ')' : book(x));

  const sml = (x, prec) => { // prec: 0 top, 1 left of an arrow, 2 operand of *, 3 argument of a type constructor
    x = prune(x);
    switch (x.tag) {
      case 'var': return varName(x);
      case 'fn': {
        const s = sml(x.from, 1) + ' -> ' + sml(x.to, 0);
        return prec >= 1 ? '(' + s + ')' : s;
      }
      case 'tuple': {
        if (x.items.length === 0) return 'unit';
        const s = x.items.map((i) => sml(i, 2)).join(' * ');
        return prec >= 2 ? '(' + s + ')' : s;
      }
      case 'con':
        if (x.args.length === 0) return tyNameText(x.name);
        if (x.args.length === 1) return sml(x.args[0], 3) + ' ' + tyNameText(x.name);
        return '(' + x.args.map((a) => sml(a, 0)).join(', ') + ') ' + tyNameText(x.name);
      default: return '?';
    }
  };

  return style === 'book' ? book(t) : sml(t, 0);
}
