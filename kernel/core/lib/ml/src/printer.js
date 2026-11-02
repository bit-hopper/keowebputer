// Printing values and declaration echoes (MLspec.md section 5.9). Two styles over one printer:
//
//                          book (default)             sml
//   constructor + argument Onion(Skewer)              Onion Skewer
//   nested                 Onion(Onion(Skewer))       Onion (Onion Skewer)
//   tuple, unit            (Calamari,Ravioli), ()     the same
//   function               fn                         fn
//   exception value        No_bacon(0)                No_bacon 0
//   type variables         α β γ                      'a 'b 'c
//   list, string, char     [1,2,3]  "a\n"  #"a"       the same
//
// Types are printed by `typeToString` (types.js). A value deeper than `depth` shows as `…`, and a list longer than `length`
// ends in `…` (`...` in sml style, as SML/NJ writes it).
import { typeToString } from './types.js';
import { NIL_INFO, CONS_INFO } from './basis.js';
import { intText } from './values.js';

export const DEFAULT_DEPTH = 100;
export const DEFAULT_LENGTH = 1000;

// A character as it is written inside quotes: SML's escapes (\n \t \" \\ ...), \^A for the other control characters, \ddd
// (decimal) from 127 to 255 and \uxxxx beyond.
const ESCAPES = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\t': '\\t', '\x07': '\\a', '\b': '\\b', '\v': '\\v', '\f': '\\f', '\r': '\\r' };
function escapeChar(c) {
  if (Object.prototype.hasOwnProperty.call(ESCAPES, c)) return ESCAPES[c];
  const code = c.charCodeAt(0);
  if (code < 32) return '\\^' + String.fromCharCode(code + 64);
  if (code >= 127 && code < 256) return '\\' + String(code).padStart(3, '0');
  if (code >= 256) return '\\u' + code.toString(16).padStart(4, '0');
  return c;
}
export const showString = (str) => '"' + Array.from(str, escapeChar).join('') + '"';
export const showChar = (c) => '#"' + escapeChar(c) + '"';

const isList = (v) => v !== null && typeof v === 'object' && v.tag === 'con' && (v.con === CONS_INFO || v.con === NIL_INFO);

// SML puts a constructor's argument in parentheses unless it is a single token or already bracketed.
function atomicSml(v) {
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' || Array.isArray(v) || isList(v)) return true;
  return (v.tag === 'con' || v.tag === 'exn') ? v.arg === undefined : true;
}

// [a,b,c], walked iteratively so a very long list cannot overflow the JS stack.
function showList(v, style, depth, length) {
  const parts = [];
  let more = false;
  for (let l = v; l.con === CONS_INFO; l = l.arg[1]) {
    if (parts.length >= length) { more = true; break; }
    parts.push(showValue(l.arg[0], style, depth - 1, length));
  }
  if (more) parts.push(style === 'book' ? '…' : '...');
  return '[' + parts.join(',') + ']';
}

export function showValue(v, style = 'book', depth = DEFAULT_DEPTH, length = DEFAULT_LENGTH) {
  if (depth <= 0) return '…';
  if (typeof v === 'number' || typeof v === 'bigint') return intText(v);
  if (typeof v === 'string') return showString(v);
  if (Array.isArray(v)) return '(' + v.map((x) => showValue(x, style, depth - 1, length)).join(',') + ')';
  if (v.tag === 'char') return showChar(v.c);
  if (isList(v)) return showList(v, style, depth, length);
  if (v.tag === 'con' || v.tag === 'exn') {
    const name = v.tag === 'con' ? v.con.name : v.excon.name;
    if (v.arg === undefined) return name;
    const arg = showValue(v.arg, style, depth - 1, length);
    if (style === 'book') return Array.isArray(v.arg) && v.arg.length > 1 ? name + arg : name + '(' + arg + ')';
    return name + ' ' + (atomicSml(v.arg) ? arg : '(' + arg + ')');
  }
  return 'fn';
}

// A type in argument position of `of`: the book parenthesises every compound type, SML only where precedence needs it.
const compound = (t) => {
  while (t.tag === 'var' && t.ref) t = t.ref;
  return t.tag === 'fn' || (t.tag === 'tuple' && t.items.length > 1) || (t.tag === 'con' && t.args.length > 0);
};
function ofType(t, style, names) {
  const s = typeToString(t, style, names);
  return style === 'book' && compound(t) ? '(' + s + ')' : s;
}

const tyvarHead = (params, style, names) => {
  const ps = params.map((p) => typeToString(p, style, names));
  if (ps.length === 0) return '';
  return ps.length === 1 ? ps[0] + ' ' : '(' + ps.join(', ') + ') ';
};

export function datatypeText(tn, style = 'book') {
  const names = new Map();
  const head = tyvarHead(tn.params, style, names);
  const cons = tn.cons.map((c) => (c.ty ? c.name + ' of ' + ofType(c.ty, style, names) : c.name));
  return 'datatype ' + head + tn.name + ' = ' + cons.join(' | ');
}

// One echo entry from the elaborator -> its text. `valueOf(name)` gives the run-time value of a `val` entry.
export function echoText(entry, valueOf, style = 'book', depth = DEFAULT_DEPTH, length = DEFAULT_LENGTH) {
  switch (entry.kind) {
    case 'val': return 'val ' + entry.name + ' = ' + showValue(valueOf(entry.name), style, depth, length) + ' : ' + typeToString(entry.type, style, new Map());
    case 'datatype': return entry.names.map((tn) => datatypeText(tn, style)).join('\n');
    case 'type': {
      const names = new Map();
      const head = tyvarHead(entry.params, style, names);
      return 'type ' + head + entry.name + ' = ' + typeToString(entry.body, style, names);
    }
    case 'exception': return 'exception ' + entry.name + (entry.ty ? ' of ' + ofType(entry.ty, style, new Map()) : '');
    case 'signature': return signatureText(entry.name, entry.sig, style);
    case 'structure': return structureText(entry.name, entry.env, entry.sigName, style);
    case 'functor': return functorText(entry.name, entry.fn, style);
    default: return entry.kind;
  }
}

// ---- modules -------------------------------------------------------------------------------------------------------

const pad = (n) => '  '.repeat(n);

// Where each of a signature's placeholder types sits, as a path: the `a_N.number` a sharing line talks about.
function flexPaths(env, prefix = [], out = new Map()) {
  for (const [name, e] of env.types) if (e.kind === 'tyname') out.set(e.tyname, prefix.concat(name).join('.'));
  for (const [name, s] of env.strs) flexPaths(s.env, prefix.concat(name), out);
  return out;
}

// The members of an environment, one line each, at `depth` indentation.
function memberLines(env, style, depth) {
  const lines = [];
  for (const [name, e] of env.types) {
    if (e.kind === 'abbrev') {
      const names = new Map();
      const head = tyvarHead(e.params, style, names);
      lines.push(pad(depth) + 'type ' + head + name + ' = ' + typeToString(e.body, style, names));
    } else if (e.tyname.isDatatype && e.tyname.cons.length && e.tyname.cons.every((c) => env.vals.get(c.name) === c.info)) {
      lines.push(...datatypeText(e.tyname, style).split('\n').map((l) => pad(depth) + l));
    } else {
      const head = e.tyname.arity === 0 ? '' : e.tyname.arity === 1 ? (style === 'book' ? 'α ' : "'a ") : '(' + Array.from({ length: e.tyname.arity }, (_, i) => (style === 'book' ? 'αβγδεζηθ'[i] : "'" + 'abcdefgh'[i])).join(', ') + ') ';
      lines.push(pad(depth) + 'type ' + head + name);
    }
  }
  for (const [name, info] of env.vals) {
    if (info.kind === 'exn') {
      lines.push(pad(depth) + 'exception ' + name + (info.hasArg ? ' of ' + ofType(info.scheme.from, style, new Map()) : ''));
    } else if (info.kind === 'var') {
      lines.push(pad(depth) + 'val ' + name + ' : ' + typeToString(info.scheme, style, new Map()));
    }
  }
  for (const [name, s] of env.strs) {
    if (s.sigName) lines.push(pad(depth) + 'structure ' + name + ' : ' + s.sigName);
    else lines.push(pad(depth) + 'structure ' + name + ' :', pad(depth + 1) + 'sig', ...memberLines(s.env, style, depth + 2), pad(depth + 1) + 'end');
  }
  return lines;
}

const sigBodyLines = (env, style, depth) => [pad(depth) + 'sig', ...memberLines(env, style, depth + 1), pad(depth) + 'end'];

export function signatureText(name, sig, style = 'book') {
  const lines = sigBodyLines(sig.env, style, 1);
  const paths = flexPaths(sig.env);
  const sharing = sig.sharing.map(([a, b]) => '    sharing type ' + (paths.get(a.name) || a.name.name) + ' = ' + (paths.get(b.name) || b.name.name));
  if (sharing.length) lines.splice(lines.length - 1, 0, ...sharing);
  return 'signature ' + name + ' =\n' + lines.join('\n');
}

export function structureText(name, env, sigName, style = 'book') {
  if (sigName) return 'structure ' + name + ' : ' + sigName;
  return 'structure ' + name + ' :\n' + sigBodyLines(env, style, 1).join('\n');
}

export function functorText(name, fn, style = 'book') {
  const paths = flexPaths(fn.sig.env);
  let param;
  if (fn.derived) {
    const parts = [];
    for (const [pname, s] of fn.sig.env.strs) parts.push('structure ' + pname + ' : ' + (s.sigName || 'sig … end'));
    for (const [a, b] of fn.sig.sharing) parts.push('sharing type ' + (paths.get(a.name) || a.name.name) + ' = ' + (paths.get(b.name) || b.name.name));
    param = parts.join(' ');
  } else {
    param = fn.paramName + ' : ' + (fn.sig.name || 'sig … end');
  }
  const head = 'functor ' + name + '(' + param + ')';
  if (fn.resultSigName) return head + ' : ' + fn.resultSigName;
  return head + ' :\n' + sigBodyLines(fn.result, style, 1).join('\n');
}
