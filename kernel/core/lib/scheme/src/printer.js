// display / write, plus classic-REPL-style condition report strings.
import {
  Pair, NIL, UNSPEC, DEFAULT, EOF, UNASSIGNED, UNBOUND, Sym, Char, SString, Flonum, Ratnum,
  Values, Closure, Primitive, MPrim, Continuation, Parameter, Promise_, Environment,
  RecordType, Record, DataType, Variant, HashTable, Cell, Condition, Port, stripSym,
} from './types.js';
import { numberToString } from './numeric.js';
import { ORDINALS } from './errors.js';

// Object hash numbers for #[compound-procedure 12 f] style output (numbering starts at 12, as in the reference REPL).
const hashNumbers = new WeakMap();
let nextHash = 12;
export function hashNumber(obj) {
  let n = hashNumbers.get(obj);
  if (n === undefined) { n = nextHash++; hashNumbers.set(obj, n); }
  return n;
}

const CHAR_WRITE_NAMES = { 32: 'space', 10: 'newline', 9: 'tab', 0: 'null', 13: 'return', 27: 'altmode', 8: 'backspace', 127: 'delete', 7: 'U+7', 12: 'U+C' };

export const printSettings = {
  abbreviateQuote: false, // false: (quote a)   true: 'a
};

const MAX_DEPTH = 2000;
const MAX_CYCLE_ELEMS = 1000;

function writeString(s) {
  let out = '"';
  for (const ch of s) {
    switch (ch) {
      case '"': out += '\\"'; break;
      case '\\': out += '\\\\'; break;
      case '\n': out += '\\n'; break;
      case '\t': out += '\\t'; break;
      case '\r': out += '\\r'; break;
      default: out += ch;
    }
  }
  return out + '"';
}
function writeSymbol(name) {
  if (name === '' || /[\s()[\]"';|]/.test(name)) return '|' + name.replace(/\|/g, '\\|') + '|';
  return name;
}

export function toDisplay(x) { return print(x, false); }
export function toWrite(x) { return print(x, true); }

export function print(x, write) {
  const parts = [];
  emit(x, write, parts, 0);
  return parts.join('');
}

function emit(x, write, out, depth) {
  if (depth > MAX_DEPTH) { out.push('...'); return; }
  if (x === true) { out.push('#t'); return; }
  if (x === false) { out.push('#f'); return; }
  if (typeof x === 'number' || typeof x === 'bigint' || x instanceof Flonum || x instanceof Ratnum) { out.push(numberToString(x)); return; }
  if (x instanceof Sym) { out.push(write ? writeSymbol(stripSym(x).name) : stripSym(x).name); return; }
  if (x instanceof SString) { out.push(write ? writeString(x.s) : x.s); return; }
  if (x instanceof Char) {
    if (!write) { out.push(String.fromCodePoint(x.cp)); return; }
    out.push('#\\' + (CHAR_WRITE_NAMES[x.cp] || String.fromCodePoint(x.cp)));
    return;
  }
  if (x === NIL) { out.push('()'); return; }
  if (x instanceof Pair) { emitList(x, write, out, depth); return; }
  if (Array.isArray(x)) {
    out.push('#(');
    for (let i = 0; i < x.length; i++) {
      if (i > 0) out.push(' ');
      if (i >= MAX_CYCLE_ELEMS * 10) { out.push('...'); break; }
      emit(x[i], write, out, depth + 1);
    }
    out.push(')');
    return;
  }
  if (x === UNSPEC) { return; } // the REPL shows nothing for the unspecific value; inside data see below
  if (x === DEFAULT) { out.push('#!default'); return; }
  if (x === EOF) { out.push('#[eof]'); return; }
  if (x === UNASSIGNED) { out.push('#!unassigned'); return; }
  if (x === UNBOUND) { out.push('#!unbound'); return; }
  if (x instanceof Closure) {
    const name = x.lam.name;
    out.push('#[compound-procedure ' + hashNumber(x) + (name ? ' ' + name : '') + ']');
    return;
  }
  if (x instanceof Primitive || x instanceof MPrim) { out.push('#[compiled-procedure ' + hashNumber(x) + ' ("' + x.name + '" #x10) #xbc ' + x.name + ']'); return; }
  if (x instanceof Continuation) { out.push('#[continuation ' + hashNumber(x) + ']'); return; }
  if (x instanceof Parameter) { out.push('#[compiled-procedure ' + hashNumber(x) + ' ("global" #x10) #xbc parameter]'); return; }
  if (x instanceof Promise_) { out.push('#[promise ' + hashNumber(x) + ']'); return; }
  if (x instanceof Environment) { out.push('#[environment ' + x.name + ']'); return; }
  if (x instanceof RecordType) { out.push('#[record-type ' + hashNumber(x) + ' ' + x.name + ']'); return; }
  if (x instanceof Variant) {
    out.push('#(struct:' + x.name);
    for (const v of x.vals) { out.push(' '); emit(v, write, out, depth + 1); }
    out.push(')');
    return;
  }
  if (x instanceof DataType) { out.push('#[datatype ' + x.name + ']'); return; }
  if (x instanceof Record) {
    const t = x.type;
    out.push('#[' + t.name + ' ' + hashNumber(x) + ']');
    return;
  }
  if (x instanceof HashTable) { out.push('#[hash-table ' + hashNumber(x) + ']'); return; }
  if (x instanceof Cell) { out.push('#[cell ' + hashNumber(x) + ']'); return; }
  if (x instanceof Condition) { out.push('#[condition ' + hashNumber(x) + ' ' + conditionTypeName(x) + ']'); return; }
  if (x instanceof Port) { out.push('#[port ' + hashNumber(x) + ']'); return; }
  if (x instanceof Values) {
    for (let i = 0; i < x.vals.length; i++) { if (i > 0) out.push(' '); emit(x.vals[i], write, out, depth + 1); }
    return;
  }
  out.push('#[object ' + String(x) + ']');
}

function emitList(x, write, out, depth) {
  // (quote a) abbreviation, when enabled
  if (printSettings.abbreviateQuote && x.car instanceof Sym && x.cdr instanceof Pair && x.cdr.cdr === NIL) {
    const n = stripSym(x.car).name;
    const prefix = n === 'quote' ? "'" : n === 'quasiquote' ? '`' : n === 'unquote' ? ',' : n === 'unquote-splicing' ? ',@' : null;
    if (prefix) { out.push(prefix); emit(x.cdr.car, write, out, depth + 1); return; }
  }
  out.push('(');
  let count = 0;
  let slow = x;
  let first = true;
  while (x instanceof Pair) {
    if (!first) out.push(' ');
    first = false;
    emitElem(x.car, write, out, depth + 1);
    x = x.cdr;
    count++;
    if ((count & 1) === 0) {
      slow = slow.cdr;
      if (slow === x) { out.push(' ...'); out.push(')'); return; } // cdr cycle
    }
    if (count > 5_000_000) { out.push(' ...'); out.push(')'); return; }
  }
  if (x !== NIL) { out.push(' . '); emitElem(x, write, out, depth + 1); }
  out.push(')');
}
// Inside data structures the unspecific value is visible (the reference REPL prints it that way too).
function emitElem(x, write, out, depth) {
  if (x === UNSPEC) { out.push('#!unspecific'); return; }
  emit(x, write, out, depth);
}

function conditionTypeName(c) {
  switch (c.kind) {
    case 'simple-error': return 'simple-error';
    case 'wrong-type': return 'wrong-type-argument';
    case 'bad-range': return 'bad-range-argument';
    case 'unbound-variable': return 'unbound-variable';
    case 'unassigned-variable': return 'unassigned-variable';
    case 'divide-by-zero': return 'divide-by-zero';
    case 'inapplicable-object': return 'inapplicable-object';
    case 'wrong-number-of-arguments': return 'wrong-number-of-arguments';
    default: return c.kind;
  }
}

function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

function arityDescription(proc) {
  let min, max;
  if (proc instanceof Closure) {
    min = proc.lam.nreq;
    max = proc.lam.rest ? -1 : proc.lam.nreq + proc.lam.nopt;
  } else { min = proc.min; max = proc.max; }
  if (max === min) return 'exactly ' + plural(min, 'argument');
  if (max < 0) return 'at least ' + plural(min, 'argument');
  return 'between ' + min + ' and ' + plural(max, 'argument');
}

// The message the reference REPL prints for an uncaught condition (without the leading ';').
export function conditionReport(c) {
  switch (c.kind) {
    case 'simple-error': {
      let s = typeof c.message === 'string' ? c.message : (c.message instanceof SString ? c.message.s : toWrite(c.message));
      for (const irr of c.irritants) s += ' ' + toWrite(irr);
      return s;
    }
    case 'wrong-type':
      return 'The object ' + toWrite(c.irritants[0]) + ', passed as the ' + ORDINALS[c.extra.argIndex] +
        ' argument to ' + c.extra.procName + ', is not the correct type.';
    case 'bad-range':
      return 'The object ' + toWrite(c.irritants[0]) + ', passed as the ' + ORDINALS[c.extra.argIndex] +
        ' argument to ' + c.extra.procName + ', is not in the correct range.';
    case 'unbound-variable': return 'Unbound variable: ' + c.extra.name;
    case 'unassigned-variable': return 'Unassigned variable: ' + c.extra.name;
    case 'divide-by-zero': return 'Division by zero signalled by ' + c.extra.procName + '.';
    case 'inapplicable-object': return 'The object ' + toWrite(c.irritants[0]) + ' is not applicable.';
    case 'wrong-number-of-arguments':
      return 'The procedure ' + toWrite(c.irritants[0]) + ' has been called with ' +
        plural(c.extra.nargs, 'argument') + '; it requires ' + arityDescription(c.irritants[0]) + '.';
    case 'syntax-error':
      return c.irritants.length ? c.message + ': ' + toWrite(c.irritants[0]) : c.message;
    case 'parse-error': return c.message;
    case 'handler-returned': return 'Exception handler returned from non-continuable raise';
    default:
      return typeof c.message === 'string' ? c.message : toDisplay(c.message);
  }
}

// What the REPL shows for an uncaught `raise` of a non-condition object.
export function uncaughtReport(obj) {
  if (obj instanceof Condition) return conditionReport(obj);
  return 'The object ' + toWrite(obj) + ', passed as the first argument to raise, is not the correct type.';
}
