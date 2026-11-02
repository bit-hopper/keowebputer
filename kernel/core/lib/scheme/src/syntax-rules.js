// syntax-rules. Mostly-hygienic by renaming: every symbol a template introduces
// (i.e. one that isn't a pattern variable) is replaced by a fresh alias
// carrying the macro's definition scope. The compiler resolves an alias that
// ended up bound by an enclosing binder to that binder (so introduced `tmp`
// can't capture a user variable `tmp`), and otherwise falls back to the base
// symbol's meaning in the macro's definition scope. Known limitation: no
// reference-transparency tricks beyond that (see SchemeSpec.md section 4.4).
import { Pair, NIL, Sym, intern, stripSym, makeAlias, listToArray, arrayToList } from './types.js';
import { syntaxError } from './errors.js';

const ELLIPSIS = intern('...');
const UNDERSCORE = intern('_');

function sameSym(a, b) { return stripSym(a) === stripSym(b); }

class EllipsisMatch { constructor(items) { this.items = items; } }

export class SyntaxRules {
  // spec: the (syntax-rules ...) form
  constructor(spec, defScope) {
    this.defScope = defScope;
    let rest = spec.cdr;
    this.ellipsis = ELLIPSIS;
    if (rest instanceof Pair && rest.car instanceof Sym) { // custom ellipsis identifier
      this.ellipsis = rest.car;
      rest = rest.cdr;
    }
    if (!(rest instanceof Pair)) throw syntaxError('Ill-formed special form', spec);
    const lits = listToArray(rest.car);
    if (lits === null) throw syntaxError('Ill-formed special form', spec);
    this.literals = lits;
    this.rules = [];
    const rules = listToArray(rest.cdr);
    if (rules === null) throw syntaxError('Ill-formed special form', spec);
    for (const r of rules) {
      const parts = listToArray(r);
      if (!parts || parts.length !== 2) throw syntaxError('Ill-formed special form', spec);
      this.rules.push({ pattern: parts[0], template: parts[1] });
    }
  }

  expand(form) {
    for (const rule of this.rules) {
      const b = new Map();
      // The keyword position of the pattern is ignored.
      if (rule.pattern instanceof Pair && this.match(rule.pattern.cdr, form.cdr, b)) {
        return this.instantiate(rule.template, b, new Map(), true);
      }
    }
    throw syntaxError('Ill-formed special form', stripForm(form));
  }

  isEllipsis(x) { return x instanceof Sym && sameSym(x, this.ellipsis); }
  isLiteral(p) { return this.literals.some((l) => sameSym(l, p)); }

  match(pat, x, b) {
    if (pat instanceof Sym) {
      if (this.isLiteral(pat)) return x instanceof Sym && sameSym(x, pat);
      if (sameSym(pat, UNDERSCORE)) return true;
      b.set(pat, x);
      return true;
    }
    if (pat instanceof Pair) {
      if (pat.cdr instanceof Pair && this.isEllipsis(pat.cdr.car)) {
        const after = pat.cdr.cdr;
        let tailLen = 0, p = after;
        while (p instanceof Pair) { tailLen++; p = p.cdr; }
        const items = [];
        let xs = x;
        while (xs instanceof Pair) { items.push(xs.car); xs = xs.cdr; }
        const avail = items.length - tailLen;
        if (avail < 0) return false;
        const matches = [];
        for (let i = 0; i < avail; i++) {
          const m = new Map();
          if (!this.match(pat.car, items[i], m)) return false;
          matches.push(m);
        }
        for (const v of this.patternVars(pat.car)) b.set(v, new EllipsisMatch(matches.map((m) => m.get(v))));
        // Match the remainder of x against the patterns after the ellipsis.
        let rest = x;
        for (let i = 0; i < avail; i++) rest = rest.cdr;
        return this.match(after, rest, b);
      }
      if (!(x instanceof Pair)) return false;
      return this.match(pat.car, x.car, b) && this.match(pat.cdr, x.cdr, b);
    }
    if (pat === NIL) return x === NIL;
    if (Array.isArray(pat)) return Array.isArray(x) && this.match(arrayToList(pat), arrayToList(x), b);
    return equalDatum(pat, x);
  }

  patternVars(pat, out = []) {
    if (pat instanceof Sym) {
      if (!this.isLiteral(pat) && !this.isEllipsis(pat) && !sameSym(pat, UNDERSCORE)) out.push(pat);
    } else if (pat instanceof Pair) {
      this.patternVars(pat.car, out);
      this.patternVars(pat.cdr, out);
    } else if (Array.isArray(pat)) pat.forEach((p) => this.patternVars(p, out));
    return out;
  }

  instantiate(t, b, renames, useEllipsis) {
    if (t instanceof Sym) {
      if (b.has(t)) {
        const v = b.get(t);
        if (v instanceof EllipsisMatch) throw syntaxError('Pattern variable used without ellipsis in macro template', stripSym(t));
        return v;
      }
      let a = renames.get(t);
      if (!a) { a = makeAlias(t, this.defScope); renames.set(t, a); }
      return a;
    }
    if (t instanceof Pair) {
      if (useEllipsis && this.isEllipsis(t.car) && t.cdr instanceof Pair) { // (... template)
        return this.instantiate(t.cdr.car, b, renames, false);
      }
      if (useEllipsis && t.cdr instanceof Pair && this.isEllipsis(t.cdr.car)) {
        let depth = 0, rest = t.cdr;
        while (rest instanceof Pair && this.isEllipsis(rest.car)) { depth++; rest = rest.cdr; }
        const results = this.expandEllipsis(t.car, b, renames, depth);
        const tail = this.instantiate(rest, b, renames, useEllipsis);
        return arrayToList(results, tail);
      }
      return new Pair(this.instantiate(t.car, b, renames, useEllipsis), this.instantiate(t.cdr, b, renames, useEllipsis));
    }
    if (Array.isArray(t)) {
      return listToArray(this.instantiate(arrayToList(t), b, renames, useEllipsis));
    }
    return t;
  }

  expandEllipsis(sub, b, renames, depth) {
    const vars = this.templateVars(sub).filter((v) => b.get(v) instanceof EllipsisMatch);
    if (vars.length === 0) throw syntaxError('No pattern variable with ellipsis in macro template', stripForm(sub));
    let len = -1;
    for (const v of vars) {
      const n = b.get(v).items.length;
      if (len === -1 || n < len) len = n;
    }
    const out = [];
    for (let i = 0; i < len; i++) {
      const b2 = new Map(b);
      for (const v of vars) b2.set(v, b.get(v).items[i]);
      if (depth > 1) out.push(...this.expandEllipsis(sub, b2, renames, depth - 1));
      else out.push(this.instantiate(sub, b2, renames, true));
    }
    return out;
  }

  templateVars(t, out = []) {
    if (t instanceof Sym) out.push(t);
    else if (t instanceof Pair) { this.templateVars(t.car, out); this.templateVars(t.cdr, out); }
    else if (Array.isArray(t)) t.forEach((x) => this.templateVars(x, out));
    return out;
  }
}

function equalDatum(a, b) {
  if (a === b) return true;
  if (a && b && a.s !== undefined && b.s !== undefined && typeof a.s === 'string') return a.s === b.s;
  if (a && b && a.cp !== undefined && b.cp !== undefined) return a.cp === b.cp;
  return false;
}

// Replace aliases by their base symbols for error messages.
export function stripForm(x) {
  if (x instanceof Sym) return stripSym(x);
  if (x instanceof Pair) return new Pair(stripForm(x.car), stripForm(x.cdr));
  return x;
}
