// Run-time values (MLspec.md section 6.5).
//
//   int         a JS number while it is a safe integer, otherwise a BigInt; always inside -2^62 .. 2^62-1, and always in
//               the canonical form (so two equal ints are `===`)
//   datatype    {tag:'con', con: ConInfo, arg}            arg is undefined for a nullary constructor (a shared singleton)
//   string      a JS string
//   char        {tag:'char', c}, interned by charValue (so two equal chars are `===`)
//   list        an ordinary datatype value: nil is the singleton {tag:'con', con: NIL_INFO}, x :: xs is
//               {tag:'con', con: CONS_INFO, arg: [x, xs]}
//   tuple       a JS array; unit is the empty array
//   functions   {tag:'closure', rules, env}  {tag:'confn', con}  {tag:'excon', ...}  {tag:'prim', name}
//   exception   {tag:'exn', excon, arg}      `excon` is the identity: {tag:'excon', name, id, hasArg}; every evaluation of an
//               `exception` declaration makes a new one, so a functor applied twice has two distinct exceptions
export const INT_MIN = -(1n << 62n);
export const INT_MAX = (1n << 62n) - 1n;

// Canonical form of an in-range BigInt (or number).
export function normInt(x) {
  if (typeof x === 'number') return Number.isSafeInteger(x) ? x : normInt(BigInt(x));
  return (x >= -9007199254740991n && x <= 9007199254740991n) ? Number(x) : x;
}

// SML writes a negative int with ~.
export const intText = (x) => (x < 0 ? '~' + String(-x) : String(x));

const chars = new Map();
export function charValue(c) {
  let v = chars.get(c);
  if (!v) { v = { tag: 'char', c }; chars.set(c, v); }
  return v;
}

export class Overflow extends Error {}

// The result of a big-integer operation, canonical, or an Overflow signal when outside the 63-bit range.
function checked(big) {
  if (big < INT_MIN || big > INT_MAX) throw new Overflow();
  return normInt(big);
}

export const intAdd = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a + b;
    if (Number.isSafeInteger(r)) return r;
  }
  return checked(BigInt(a) + BigInt(b));
};
export const intSub = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a - b;
    if (Number.isSafeInteger(r)) return r;
  }
  return checked(BigInt(a) - BigInt(b));
};
export const intMul = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a * b;
    if (Number.isSafeInteger(r)) return r === 0 ? 0 : r; // (no negative zero)
  }
  return checked(BigInt(a) * BigInt(b));
};
export const intNeg = (a) => (typeof a === 'number' ? (a === 0 ? 0 : -a) : checked(-a));

// Floor division and modulus (the sign of the divisor), as SML defines div and mod. Caller has ruled out zero.
export function intDiv(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return floorDivSafe(a, b);
  const x = BigInt(a);
  const y = BigInt(b);
  let q = x / y;
  if ((x % y !== 0n) && ((x < 0n) !== (y < 0n))) q -= 1n;
  return checked(q);
}
function floorDivSafe(a, b) {
  // a / b can lose precision near 2^53; use the exact remainder to correct
  const r = a % b;
  let q = (a - r) / b;
  if (r !== 0 && ((r < 0) !== (b < 0))) q -= 1;
  return q === 0 ? 0 : q;
}
export function intMod(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a % b;
    return (r !== 0 && ((r < 0) !== (b < 0))) ? r + b : (r === 0 ? 0 : r);
  }
  const x = BigInt(a);
  const y = BigInt(b);
  let r = x % y;
  if (r !== 0n && ((r < 0n) !== (y < 0n))) r += y;
  return normInt(r);
}

// ---- exceptions --------------------------------------------------------------------------------------------------

let nextExcon = 1;
export const makeExcon = (name, hasArg) => ({ tag: 'excon', name, id: nextExcon++, hasArg });
export const exnValue = (excon, arg) => ({ tag: 'exn', excon, arg });

// The exceptions of the initial basis. One identity each, shared by every interpreter in the process: the machine raises
// these itself (Div, Overflow, Match, Bind; Empty, Option, Chr from the list, option and char primitives), whatever a program
// later declares under the same name.
export const BUILTIN_EXN = {};
for (const name of ['Div', 'Overflow', 'Match', 'Bind', 'Empty', 'Option', 'Chr']) BUILTIN_EXN[name] = exnValue(makeExcon(name, false), undefined);

// ---- structural equality -------------------------------------------------------------------------------------------

// `=` on values of an equality type: ints, strings, chars (interned), datatype values and tuples (never functions or
// exceptions, the type checker rules them out). Iterative, so a very long recursive structure cannot overflow the JS stack.
export function valuesEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' || typeof b === 'number') return false; // canonical ints: unequal unless ===
  const stack = [a, b];
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    if (x === y) continue;
    if (Array.isArray(x)) {
      if (!Array.isArray(y) || x.length !== y.length) return false;
      for (let i = x.length - 1; i >= 0; i--) stack.push(x[i], y[i]);
    } else if (x !== null && typeof x === 'object' && x.tag === 'con') {
      if (y.con !== x.con) return false;
      if (x.arg !== undefined) stack.push(x.arg, y.arg);
    } else {
      return false; // two distinct ints
    }
  }
  return true;
}
