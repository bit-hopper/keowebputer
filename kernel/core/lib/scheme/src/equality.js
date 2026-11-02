import { Pair, Char, SString, Flonum, Ratnum, Record, Variant } from './types.js';
import { eqvNum } from './numeric.js';

export function eq(a, b) {
  return a === b || (a instanceof Char && b instanceof Char && a.cp === b.cp);
}

export function eqv(a, b) {
  if (a === b) return true;
  if (a instanceof Flonum || a instanceof Ratnum) return eqvNum(a, b);
  if (a instanceof Char) return b instanceof Char && a.cp === b.cp;
  return false;
}

export function equal(a, b) {
  for (;;) {
    if (eqv(a, b)) return true;
    if (a instanceof Pair) {
      if (!(b instanceof Pair)) return false;
      if (!equal(a.car, b.car)) return false;
      a = a.cdr; b = b.cdr;
      continue;
    }
    if (a instanceof SString) return b instanceof SString && a.s === b.s;
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
      return true;
    }
    if (a instanceof Variant) {
      if (!(b instanceof Variant) || a.dt !== b.dt || a.name !== b.name) return false;
      for (let i = 0; i < a.vals.length; i++) if (!equal(a.vals[i], b.vals[i])) return false;
      return true;
    }
    if (a instanceof Record) {
      if (!(b instanceof Record) || a.type !== b.type) return false;
      for (let i = 0; i < a.vals.length; i++) if (!equal(a.vals[i], b.vals[i])) return false;
      return true;
    }
    return false;
  }
}
