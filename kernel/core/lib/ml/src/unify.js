// Unification with an occurs check, level adjustment (for let-generalisation) and equality types.
// A failure throws a UnifyFailure; the elaborator wraps it with the AST node and the "expected" side so the message can
// say what consumed what (MLspec.md section 6.3).
import { prune, occurs, ORDERED } from './types.js';

//   reason: 'mismatch' (two shapes that cannot be the same type; `a`/`b` are the innermost pair that clashed)
//           'occurs'   (a variable would contain itself: `fn x => x x`)
//           'equality' (a type that has no equality, where one is needed; `a` is that type)
//           'overload' (a type that is not int, string or char, where a comparison needs one of those; `a` is that type)
export class UnifyFailure extends Error {
  constructor(reason, a, b) {
    super('unify: ' + reason);
    this.reason = reason;
    this.a = a;
    this.b = b;
  }
}

// Lower the level of every variable in `t` to at most `level` (the variable being bound lives at `level`, so anything
// it now mentions must not be generalised before it is). Fails an `eq` variable binding to a non-equality type.
function adjust(t, level, eq, ord) {
  t = prune(t);
  switch (t.tag) {
    case 'var':
      if (t.level > level) t.level = level;
      if (eq && !t.eq) {
        if (t.rigid) throw new UnifyFailure('equality', t);
        t.eq = true;
      }
      if (ord && !t.ord) {
        if (t.rigid) throw new UnifyFailure('overload', t);
        t.ord = true;
      }
      return;
    case 'fn':
      if (eq) throw new UnifyFailure('equality', t);
      if (ord) throw new UnifyFailure('overload', t);
      adjust(t.from, level, false, false); adjust(t.to, level, false, false);
      return;
    case 'tuple':
      if (ord) throw new UnifyFailure('overload', t);
      t.items.forEach((x) => adjust(x, level, eq, false));
      return;
    case 'con':
      if (eq && !t.name.admitsEq) throw new UnifyFailure('equality', t);
      if (ord && !ORDERED.has(t.name)) throw new UnifyFailure('overload', t);
      t.args.forEach((x) => adjust(x, level, eq, false));
      return;
    default:
  }
}

function bind(v, t) {
  if (occurs(v, t)) throw new UnifyFailure('occurs', v, t);
  adjust(t, v.level, v.eq, v.ord);
  v.ref = t;
}

export function unify(a, b) {
  a = prune(a);
  b = prune(b);
  if (a === b) return;
  if (a.tag === 'var' && !a.rigid) {
    if (b.tag === 'var' && !b.rigid) {
      // two flexible variables: the survivor is equality-constrained if either was, and lives at the shallower level
      if (a.eq && !b.eq) b.eq = true;
      if (a.ord) b.ord = true;
      if (a.level < b.level) b.level = a.level; else a.level = b.level;
      a.ref = b;
      return;
    }
    bind(a, b);
    return;
  }
  if (b.tag === 'var' && !b.rigid) { bind(b, a); return; }
  if (a.tag === 'var' || b.tag === 'var') throw new UnifyFailure('mismatch', a, b); // a rigid variable against anything else
  if (a.tag !== b.tag) throw new UnifyFailure('mismatch', a, b);
  switch (a.tag) {
    case 'fn':
      unify(a.from, b.from);
      unify(a.to, b.to);
      return;
    case 'tuple':
      if (a.items.length !== b.items.length) throw new UnifyFailure('mismatch', a, b);
      for (let i = 0; i < a.items.length; i++) unify(a.items[i], b.items[i]);
      return;
    case 'con':
      if (a.name !== b.name || a.args.length !== b.args.length) throw new UnifyFailure('mismatch', a, b);
      for (let i = 0; i < a.args.length; i++) unify(a.args[i], b.args[i]);
      return;
    default:
      throw new UnifyFailure('mismatch', a, b);
  }
}
