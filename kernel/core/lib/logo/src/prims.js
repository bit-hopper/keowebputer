// Primitive registration and the argument-conversion helpers every primitive uses (LOGO.md 4.2, 5.2).
//
// A primitive is a record {name, key, min, def, max, fn | op, special?}:
//   min / def / max   inputs: the fewest, the number taken without parentheses, the most (-1 = unlimited)
//   fn(args, m)       a plain primitive: receives the evaluated inputs, returns the value (or undefined for none)
//   op(m, args, want, blame, tail)
//                     a machine operation: may push frames and start further evaluation; returns PENDING when it has
//                     arranged the continuation itself, else the value to deliver (see machine.js)
// Aliases ("forward fd") register one record per name so a message can quote the name the user typed.
//
// Do NOT write a primitive that calls back into the interpreter from JS (MAP, FOREACH, RUN, ...): those must be machine
// operations so that depth, interruption, STOP / OUTPUT and THROW work through them (LOGO.md 5.3, last rule).

import { isWord, isList, isNumber, wordText, numberValue, Cell, NIL, LArray } from './data.js';
import { err } from './errors.js';
import { showForm } from './printer.js';

// True for a real primitive: a name the user may not define without REDEFP. The manual's "(library procedure)" entries are
// implemented natively here for speed but are written in Logo in the reference, so a program may define its own (the csls
// programs define quoted, remove, ...); those carry library: true.
export const isPrimRecord = (p) => (p.fn !== undefined || p.op !== undefined) && !p.library;

export class PrimTable {
  constructor(procs) { this.procs = procs; }

  _add(names, def, impl, opts, isOp) {
    const list = names.split(/\s+/);
    const min = opts.min !== undefined ? opts.min : def;
    const max = opts.max !== undefined ? opts.max : def;
    for (const name of list) {
      const rec = { name, key: name.toLowerCase(), min, def, max, special: opts.special || null };
      if (isOp) rec.op = impl; else rec.fn = impl;
      this.procs.set(rec.key, rec);
    }
  }

  // names: "canonical alias alias". def: default input count. opts: {min, max, special}.
  fn(names, def, impl, opts = {}) { this._add(names, def, impl, opts, false); }
  op(names, def, impl, opts = {}) { this._add(names, def, impl, opts, true); }
}

// ---- argument conversion -----------------------------------------------------------------------------------------
// Each throws the reference's "<name> doesn't like <value> as input" error (code 7 for a wrong type, code 4 for a value
// out of range). `who` is the primitive's name as it should appear in the message.

export function num(x, who) {
  const v = numberValue(x);
  if (v === null) throw err.badType(who, showForm(x));
  return v;
}

// An integer-valued number (3 and 3.0 are fine, 3.5 is not).
export function int(x, who) {
  const v = num(x, who);
  if (!Number.isInteger(v)) throw err.badType(who, showForm(x));
  return v;
}

// The text of a word argument; numbers print per formatNumber. Lists and arrays are not words.
export function wordArg(x, who) {
  if (!isWord(x)) throw err.badType(who, showForm(x));
  return wordText(x);
}

export function listArg(x, who) {
  if (!isList(x)) throw err.badType(who, showForm(x));
  return x;
}

export function arrayArg(x, who) {
  if (!(x instanceof LArray)) throw err.badType(who, showForm(x));
  return x;
}

// TRUE / FALSE (any case) -> boolean.
export function tf(x, who) {
  if (isWord(x)) {
    const t = wordText(x).toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
  }
  throw err.badType(who, showForm(x));
}

// A predicate result is the word "true" / "false" (what PRINT shows), lowercase as the reference prints it.
export const bool = (b) => (b ? 'true' : 'false');

export { Cell, NIL, isNumber };
