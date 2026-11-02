// Building and describing user procedures: the formals of a TO line or a DEFINE text, the Proc record, and the TEXT /
// title-line views of one (LOGO.md 4.1; manual, PROCEDURE DEFINITION).
//
// The formals of a procedure (manual, TO) come in this order: required inputs `:foo`, optional inputs `[:bar default-
// expression]`, one rest input `[:rest]`, then an optional default input count `5`. A DEFINE text writes the same without
// the colons. Min / default / max inputs: min is the required count, max is unlimited with a rest input else
// required + optional, default is the trailing number if given else min.

import { Cell, NIL, isList, isWord, wordText, numberValue, listFromArray, listToArray, nameKey } from './data.js';
import { err } from './errors.js';
import { showForm } from './printer.js';
import { Proc } from './machine.js';

const stripColon = (s) => (s.charCodeAt(0) === 58 ? s.slice(1) : s);

// Parses `items` (the formals as data: words and lists, colons optional) into `proc`. Throws a LogoError on a malformed
// formals list.
export function parseFormals(proc, items) {
  let state = 0;   // 0 required, 1 optional, 2 rest seen
  let explicitDefault = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (isList(it)) {
      const parts = listToArray(it);
      if (parts.length === 0 || !isWord(parts[0])) throw err.badType('to', showForm(it));
      const name = stripColon(wordText(parts[0]));
      if (parts.length === 1) {
        if (state === 2) throw err.badType('to', showForm(it));
        proc.rest = { key: nameKey(name), name };
        state = 2;
      } else {
        if (state === 2) throw err.badType('to', showForm(it));
        proc.optional.push({ key: nameKey(name), name, def: listFromArray(parts.slice(1)) });
        state = 1;
      }
    } else if (isWord(it)) {
      const t = wordText(it);
      if (i === items.length - 1 && numberValue(it) !== null) {   // a trailing number is the default input count
        explicitDefault = numberValue(it);
        continue;
      }
      if (state > 0) throw err.badType('to', showForm(it));
      const name = stripColon(t);
      proc.required.push({ key: nameKey(name), name });
    } else throw err.badType('to', showForm(it));
  }
  proc.min = proc.required.length;
  proc.max = proc.rest ? -1 : proc.required.length + proc.optional.length;
  proc.def = explicitDefault !== null ? explicitDefault : proc.min;
}

// A user procedure from a name, its formals as data items, and its body lines (each a list). `rawLines`, when given, are
// the source lines as typed (title, body..., END) so FULLTEXT can return them.
export function buildProc(name, formals, bodyLines, rawLines) {
  const proc = new Proc(name);
  parseFormals(proc, formals);
  proc.lines = bodyLines;
  proc.rawLines = rawLines || null;
  return proc;
}

// The formals as a DEFINE text writes them: required names, [name default...] for optional, [name] for rest, and the
// default input count when it differs from the minimum.
export function formalsList(proc) {
  const out = proc.required.map((r) => r.name);
  for (const o of proc.optional) out.push(new Cell(o.name, o.def));
  if (proc.rest) out.push(new Cell(proc.rest.name, NIL));
  if (proc.def !== proc.min) out.push(proc.def);
  return listFromArray(out);
}

// TEXT: [formals line1 line2 ...]
export function procText(proc) {
  return new Cell(formalsList(proc), listFromArray(proc.lines));
}

// The title line as TO would show it: to name :a [:b default] [:rest] 3
export function titleLine(proc) {
  let s = 'to ' + proc.name;
  for (const r of proc.required) s += ' :' + r.name;
  for (const o of proc.optional) s += ' [:' + o.name + ' ' + listToArray(o.def).map((x) => (isList(x) ? showForm(x) : wordText(x))).join(' ') + ']';
  if (proc.rest) s += ' [:' + proc.rest.name + ']';
  if (proc.def !== proc.min) s += ' ' + proc.def;
  return s;
}
