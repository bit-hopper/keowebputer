// Support for `#lang eopl` (prelude/eopl.scm): the datatype registry behind
// define-datatype / cases, a format-string helper, and a scanner/parser generator
// for the grammar-specification style used by the interpreter chapters.
//
// Behaviour follows the reference implementation of this language library (read for this
// purpose: datatype.rkt, private/sllgen.rkt): scanner = longest match with an
// action preference, `string` tokens keep their text verbatim, the leftmost
// unscannable character ends the token stream, and parse errors read
// "parsing: at line N: ...". The parser itself is more permissive than the
// original (which builds an LL(1) table): it backtracks, so it accepts a superset
// of the grammars the original accepts.
//
// Everything is installed under internal names (a leading %); the public names
// (sllgen:..., eopl:...) are defined by the library, so they only exist in a page
// that asked for it. Nothing in this file calls back into Scheme code.
import {
  Pair, NIL, UNSPEC, Sym, Char, SString, Primitive, DataType, Variant,
  intern, stripSym, arrayToList, listToArray, makeChar,
} from './types.js';
import { wrongType, schemeError } from './errors.js';
import { parseNumber } from './numeric.js';
import { toDisplay, toWrite } from './printer.js';

export function installEopl(interp) {
  const def = (name, min, max, fn) => interp.definePrimitive(new Primitive(name, min, max, fn));
  const symName = (x, i, who) => { if (!(x instanceof Sym)) throw wrongType(x, i, who); return stripSym(x).name; };
  interp.sllgenCounter = 0; // like the original's global gensym counter

  // ---------- datatypes ----------
  // (%define-datatype! 'type '((variant field ...) ...)) -- replaces an earlier type of the same name.
  def('%define-datatype!', 2, 2, (tname, specs) => {
    const name = symName(tname, 1, 'define-datatype');
    const old = interp.datatypes.get(name);
    if (old) for (const v of old.variants.keys()) if (interp.variantIndex.get(v) && interp.variantIndex.get(v).dt === old) interp.variantIndex.delete(v);
    const dt = new DataType(name);
    for (const spec of listToArray(specs) || []) {
      const parts = listToArray(spec);
      const vname = stripSym(parts[0]).name;
      const fields = parts.slice(1).map((f) => stripSym(f).name);
      dt.variants.set(vname, fields);
      interp.variantIndex.set(vname, { dt, fields });
    }
    interp.datatypes.set(name, dt);
    return dt;
  });
  def('%find-datatype', 1, 1, (tname) => {
    const dt = interp.datatypes.get(symName(tname, 1, 'find-datatype'));
    if (!dt) throw schemeError('Unknown datatype:', tname);
    return dt;
  });
  def('%datatype-predicate', 2, 2, (tname, pname) => {
    const dt = interp.datatypes.get(symName(tname, 1, 'define-datatype'));
    return new Primitive(symName(pname, 2, 'define-datatype'), 1, 1, (x) => x instanceof Variant && x.dt === dt);
  });
  // (%make-variant dt 'variant field-value ...): the checks happen in the constructor, before this
  def('%make-variant', 2, -1, (dt, vname, ...vals) => new Variant(dt, symName(vname, 2, 'make-variant'), vals));
  // (%define-alias! 'name value): a global binding made at run time (make-VARIANT compatibility names)
  def('%define-make-alias!', 2, 2, (vname, value) => { interp.defineGlobal('make-' + symName(vname, 1, 'define-datatype'), value); return UNSPEC; });
  // clause test used by the expansion of `cases`: same variant name, and the clause binds every field
  def('%variant-is?', 3, 3, (v, vname, n) => {
    if (v.name !== stripSym(vname).name) return false;
    if (v.vals.length !== n) throw schemeError('cases: variant case `' + v.name + "' for `" + v.dt.name + "' has wrong field count (expected " + v.vals.length + ', found ' + n + ')');
    return true;
  });
  def('%variant-ref', 2, 2, (v, i) => v.vals[i]);
  def('%cases-check', 2, 2, (tname, v) => {
    const name = symName(tname, 1, 'cases');
    if (!interp.datatypes.has(name)) throw schemeError('cases: not a datatype name:', tname);
    if (!(v instanceof Variant) || v.dt !== interp.datatypes.get(name)) throw schemeError('cases: not a ' + name + ': ' + toWrite(v));
    return UNSPEC;
  });
  def('%cases-no-match', 2, 2, () => { throw schemeError('cases: no variant case matched'); });
  def('%bad-field', 3, 3, (vname, fname, value) => {
    throw schemeError(stripSym(vname).name + ': bad value for ' + stripSym(fname).name + ' field: ' + toWrite(value));
  });

  // ---------- format strings: ~s ~a ~v ~% ~n ~~ ----------
  def('%format-string', 2, 2, (fmt, args) => {
    if (!(fmt instanceof SString)) throw wrongType(fmt, 1, 'format');
    const a = listToArray(args) || [];
    let used = 0, out = '';
    const s = fmt.s;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== '~') { out += c; continue; }
      const d = s[++i];
      if (d === 'a' || d === 'A') { if (used >= a.length) throw schemeError('format: too few arguments for', fmt); out += toDisplay(a[used++]); }
      else if (d === 's' || d === 'S' || d === 'v' || d === 'V') { if (used >= a.length) throw schemeError('format: too few arguments for', fmt); out += toWrite(a[used++]); }
      else if (d === '%' || d === 'n' || d === 'N') out += '\n';
      else if (d === '~') out += '~';
      else throw schemeError('format: unsupported directive ~' + (d === undefined ? '' : d) + ' in', fmt);
    }
    if (used < a.length) throw schemeError('format: too many arguments for', fmt);
    return new SString(out);
  });

  // ---------- sllgen ----------
  def('%sllgen-parser', 2, 2, (scanner, grammar) => {
    const spec = compileSpecs(interp, scanner, grammar);
    return new Primitive('parser', 1, 1, (text) => {
      if (!(text instanceof SString)) throw wrongType(text, 1, 'parser');
      return parseText(interp, spec, text.s, { prefix: false }).node;
    });
  });
  // (parser text [final?]) -> (tree . rest-of-text), or #f when more input is needed. Used by the REPL loop.
  def('%sllgen-stream-parser', 2, 2, (scanner, grammar) => {
    const spec = compileSpecs(interp, scanner, grammar);
    return new Primitive('stream-parser', 1, 2, (text, final) => {
      if (!(text instanceof SString)) throw wrongType(text, 1, 'parser');
      const r = parseText(interp, spec, text.s, { prefix: true, final: final !== undefined && final !== false });
      return r === null ? false : new Pair(r.node, new SString(r.rest));
    });
  });
  def('%sllgen-scanner', 2, 2, (scanner, grammar) => {
    const spec = compileSpecs(interp, scanner, grammar);
    return new Primitive('scanner', 1, 1, (text) => {
      if (!(text instanceof SString)) throw wrongType(text, 1, 'scanner');
      const { tokens } = scan(spec, text.s);
      return arrayToList(tokens.map((t) => arrayToList([intern(t.cls), t.data, t.line])));
    });
  });
  def('%sllgen-datatype-forms', 2, 2, (scanner, grammar) => arrayToList(datatypeForms(interp, compileSpecs(interp, scanner, grammar))));
}

// ======================= spec decoding =======================
const symOf = (x) => (x instanceof Sym ? stripSym(x).name : null);
const arr = (x, msg) => { const a = listToArray(x); if (a === null) throw schemeError(msg, x); return a; };
const gensym = (interp, base) => intern(base + (++interp.sllgenCounter));

// --- lexical specs: (class (regexp ...) action) ---
// Regular expressions become small ASTs; matching uses Brzozowski derivatives so we
// know, character by character, whether any rule can still match -- the same
// information the original keeps as its set of live scanner states.
const EPS = { t: 'eps' };
const isLetter = (ch) => /\p{L}/u.test(ch);
const isDigit = (ch) => /\p{N}/u.test(ch);
const isSpace = (ch) => /\s/u.test(ch);

function decodeRegexp(x) {
  if (x instanceof SString) return mkcat([...x.s].map((ch) => ({ t: 'set', test: (c) => c === ch })));
  if (x instanceof Char) { const ch = String.fromCodePoint(x.cp); return { t: 'set', test: (c) => c === ch }; }
  const name = symOf(x);
  if (name === 'letter') return { t: 'set', test: isLetter };
  if (name === 'digit') return { t: 'set', test: isDigit };
  if (name === 'whitespace') return { t: 'set', test: isSpace };
  if (name === 'any') return { t: 'set', test: () => true };
  if (name !== null) throw schemeError('scanner-generation: unknown tester', x);
  if (x instanceof Pair && symOf(x.car)) {
    const head = symOf(x.car);
    const rest = arr(x.cdr, 'scanner-generation: bad regexp');
    if (head === 'or') return { t: 'or', alts: rest.map(decodeRegexp) };
    if (head === 'concat') return mkcat(rest.map(decodeRegexp));
    if (head === 'arbno') {
      if (rest.length < 1) throw schemeError('scanner-generation: bad regexp', x);
      return { t: 'star', item: decodeRegexp(rest[0]) };
    }
    if (head === 'not') {
      if (!(rest[0] instanceof Char)) throw schemeError('sllgen:parse-regexp: bad regexp', x);
      const ch = String.fromCodePoint(rest[0].cp);
      return { t: 'set', test: (c) => c !== ch };
    }
  }
  throw schemeError('scanner-generation: bad regexp', x);
}
function mkcat(items) {
  const xs = items.filter((i) => i !== EPS);
  if (xs.length === 0) return EPS;
  if (xs.length === 1) return xs[0];
  return { t: 'cat', items: xs };
}
function mkor(alts) {
  const xs = alts.filter((a) => a !== null);
  if (xs.length === 0) return null;
  return xs.length === 1 ? xs[0] : { t: 'or', alts: xs };
}
function nullable(n) {
  switch (n.t) {
    case 'eps': case 'star': return true;
    case 'set': return false;
    case 'or': return n.alts.some(nullable);
    case 'cat': return n.items.every(nullable);
  }
  return false;
}
// the language of what is left after consuming ch, or null if empty
function deriv(n, ch) {
  switch (n.t) {
    case 'eps': return null;
    case 'set': return n.test(ch) ? EPS : null;
    case 'or': return mkor(n.alts.map((a) => deriv(a, ch)));
    case 'star': { const d = deriv(n.item, ch); return d === null ? null : mkcat([d, n]); }
    case 'cat': {
      const [first, ...rest] = n.items;
      const d = deriv(first, ch);
      const viaFirst = d === null ? null : mkcat([d, ...rest]);
      const viaRest = nullable(first) && rest.length ? deriv(mkcat(rest), ch) : null;
      return mkor([viaFirst, viaRest]);
    }
  }
  return null;
}

// action preference when several rules accept the same text (a keyword's own action is `string`)
const ACTION_RANK = { string: 0, 'make-string': 1, symbol: 2, 'make-symbol': 3, number: 4, 'make-number': 5, skip: 6 };

function compileSpecs(interp, scanner, grammar) {
  const rules = arr(scanner, 'sllgen: bad scanner specification').map((r) => {
    const parts = listToArray(r);
    const ok = parts && parts.length === 3 && symOf(parts[0]) && listToArray(parts[1]) !== null && symOf(parts[2]) && ACTION_RANK[symOf(parts[2])] !== undefined;
    if (!ok) throw schemeError('scanner-generation: bad scanner item', r);
    return { cls: symOf(parts[0]), action: symOf(parts[2]), re: mkcat(listToArray(parts[1]).map(decodeRegexp)) };
  });
  const tokenKinds = new Map(rules.filter((r) => r.action !== 'skip').map((r) => [r.cls, r.action.replace('make-', '')]));

  const raw = arr(grammar, 'sllgen: bad grammar').map((p) => {
    const parts = listToArray(p);
    if (!parts || parts.length !== 3 || !symOf(parts[0]) || listToArray(parts[1]) === null || !symOf(parts[2])) {
      throw schemeError('parser-generation: bad production', p);
    }
    return { lhs: symOf(parts[0]), rhs: listToArray(parts[1]), name: symOf(parts[2]) };
  });
  if (raw.length === 0) throw schemeError('parser-generation: empty grammar');
  const nonterminals = new Set(raw.map((p) => p.lhs));
  const keywords = [];

  function decodeItem(x, production) {
    if (x instanceof SString) { if (!keywords.includes(x.s)) keywords.push(x.s); return { t: 'lit', s: x.s }; }
    const n = symOf(x);
    if (n) {
      if (nonterminals.has(n)) return { t: 'nt', name: n };
      if (tokenKinds.has(n)) return { t: 'tok', name: n, kind: tokenKinds.get(n) };
      throw schemeError('defining-datatypes: illegal item ' + n + ' (unknown symbol) in rhs', arrayToList(production.rhs));
    }
    if (x instanceof Pair) {
      const head = symOf(x.car);
      const rest = listToArray(x.cdr);
      if (head === 'arbno' && rest) return withFields({ t: 'arbno', items: rest.map((i) => decodeItem(i, production)) });
      if (head === 'separated-list' && rest && rest.length > 1) {
        const sep = rest[rest.length - 1];
        if (!(sep instanceof SString) && !symOf(sep)) throw schemeError('parser-generation: illegal rhs item ' + toWrite(x) + ' in production', arrayToList(production.rhs));
        const sepItem = decodeItem(sep, production);
        return withFields({ t: 'sep', items: rest.slice(0, -1).map((i) => decodeItem(i, production)), sepItem });
      }
    }
    throw schemeError('parser-generation: illegal rhs item ' + toWrite(x) + ' in production', arrayToList(production.rhs));
  }
  const withFields = (it) => { it.nfields = it.items.reduce((n, i) => n + fieldCount(i), 0); return it; };

  const productions = raw.map((p) => ({ lhs: p.lhs, name: p.name, items: p.rhs.map((i) => decodeItem(i, p)) }));
  const byNt = new Map();
  for (const p of productions) { if (!byNt.has(p.lhs)) byNt.set(p.lhs, []); byNt.get(p.lhs).push(p); }
  return { interp, rules, keywords, keywordClass: null, productions, byNt, start: productions[0].lhs };
}

function fieldCount(it) {
  if (it.t === 'lit') return 0;
  if (it.t === 'tok' || it.t === 'nt') return 1;
  return it.nfields; // arbno / separated-list: one list per field of the repeated items
}

// ======================= scanning =======================
// Same algorithm as the original scanner: from the current position keep consuming
// characters while some rule is still alive, remember the last position at which a
// rule had accepted, then back up to it. No rule accepting anything at all (an
// unscannable first character) ends the token stream silently; characters consumed
// by live rules that never accepted are an error.
class ScanError extends Error {}

function scan(spec, text, opts = {}) {
  if (spec.keywordClass === null) spec.keywordClass = gensym(spec.interp, 'literal-string').name;
  const chars = [...text];
  const tokens = [];
  const lineAfter = (end) => { let n = 1; for (let k = 0; k < end; k++) if (chars[k] === '\n') n++; return n; };
  const charIndexToOffset = (idx) => chars.slice(0, idx).join('').length;
  let i = 0;
  while (i < chars.length) {
    let live = [];
    spec.keywords.forEach((k) => live.push({ node: decodeRegexp(new SString(k)), action: 'string', cls: spec.keywordClass }));
    for (const r of spec.rules) live.push({ node: r.re, action: r.action, cls: r.cls });
    let j = i, successEnd = -1, accepted = null;
    for (;;) {
      const acc = live.filter((s) => nullable(s.node));
      if (acc.length) { successEnd = j; accepted = acc; }
      if (j >= chars.length) break;
      const next = [];
      for (const s of live) { const d = deriv(s.node, chars[j]); if (d !== null) next.push({ node: d, action: s.action, cls: s.cls }); }
      if (next.length === 0) break;
      live = next;
      j++;
    }
    if (j === i && successEnd < i) break;          // nothing consumed: the stream ends here
    if (successEnd < 0 || accepted === null) {
      const e = new ScanError('scanning: no actions found for ' + toWrite(arrayToList(chars.slice(i, j).map((c) => makeChar(c.codePointAt(0))))));
      e.atEnd = j >= chars.length;
      throw e;
    }
    if (successEnd === i) break;                    // an accepting rule matched the empty string: original stops too
    // preferred action; among equal opcodes the rule listed last wins
    let best = accepted[0];
    for (const a of accepted) if (ACTION_RANK[a.action] <= ACTION_RANK[best.action]) best = a;
    const piece = chars.slice(i, successEnd).join('');
    if (best.action !== 'skip') {
      const base = best.action.replace('make-', '');
      const data = base === 'symbol' ? intern(piece) : base === 'number' ? parseNumber(piece) : new SString(piece);
      tokens.push({ cls: best.cls, data: data === null ? false : data, line: lineAfter(successEnd), start: charIndexToOffset(i), end: charIndexToOffset(successEnd) });
    }
    i = successEnd;
  }
  return { tokens, endLine: lineAfter(i) };
}

// ======================= parsing =======================
// Backtracking recursive descent in continuation-passing style: alternatives and
// repetitions are tried in order, and a parse succeeds only if it consumes every token.
const FAIL = undefined;
const writeData = (d) => (typeof d === 'string' ? JSON.stringify(d) : toWrite(d));

function parseText(interp, spec, text, opts) {
  let scanned;
  try {
    scanned = scan(spec, text);
  } catch (e) {
    if (e instanceof ScanError) {
      if (opts.prefix && !opts.final && e.atEnd) return null; // possibly an unfinished token: wait for more input
      throw schemeError(e.message);
    }
    throw e;
  }
  const tokens = scanned.tokens;
  const end = { cls: 'end-marker', data: false, line: scanned.endLine, start: text.length, end: text.length };
  const tok = (p) => (p < tokens.length ? tokens[p] : end);
  let far = -1, farInfo = null, leftover = -1;
  const active = new Set();
  const note = (pos, info) => { if (pos > far) { far = pos; farInfo = info; } };

  function item(it, pos, fields, k) {
    switch (it.t) {
      case 'lit': {
        const t = tok(pos);
        if (pos < tokens.length && t.data instanceof SString && t.data.s === it.s) return k(pos + 1, fields);
        note(pos, { kind: 'term', target: JSON.stringify(it.s) }); return FAIL;
      }
      case 'tok': {
        const t = tok(pos);
        if (pos < tokens.length && t.cls === it.name) return k(pos + 1, fields.concat([t.data]));
        note(pos, { kind: 'term', target: it.name }); return FAIL;
      }
      case 'nt': return nonterminal(it.name, pos, (p, node) => k(p, fields.concat([node])));
      case 'arbno': return arbno(it, pos, [], (p, cols) => k(p, fields.concat(cols)));
      case 'sep': return sepList(it, pos, [], true, (p, cols) => k(p, fields.concat(cols)));
    }
    return FAIL;
  }
  function seq(items, i, pos, fields, k) {
    if (i === items.length) return k(pos, fields);
    return item(items[i], pos, fields, (p, f) => seq(items, i + 1, p, f, k));
  }
  const columns = (iters, n) => {
    const cols = [];
    for (let c = 0; c < n; c++) cols.push(arrayToList(iters.map((f) => f[c])));
    return cols;
  };
  function arbno(it, pos, iters, k) {
    const r = seq(it.items, 0, pos, [], (p, f) => (p === pos ? FAIL : arbno(it, p, iters.concat([f]), k)));
    if (r !== FAIL) return r;
    return k(pos, columns(iters, it.nfields));
  }
  function sepList(it, pos, iters, first, k) {
    let start = pos, ok = true;
    if (!first) {
      const t = tok(pos);
      const matches = pos < tokens.length && (it.sepItem.t === 'lit' ? (t.data instanceof SString && t.data.s === it.sepItem.s) : t.cls === it.sepItem.name);
      if (matches) start = pos + 1; else { note(pos, { kind: 'term', target: it.sepItem.t === 'lit' ? JSON.stringify(it.sepItem.s) : it.sepItem.name }); ok = false; }
    }
    if (ok) {
      const r = seq(it.items, 0, start, [], (p, f) => sepList(it, p, iters.concat([f]), false, k));
      if (r !== FAIL) return r;
    }
    return k(pos, columns(iters, it.nfields));
  }
  function nonterminal(name, pos, k) {
    const key = name + '@' + pos;
    if (active.has(key)) return FAIL; // left recursion cannot be parsed top-down
    active.add(key);
    try {
      for (const p of spec.byNt.get(name)) {
        const r = seq(p.items, 0, pos, [], (e, fields) => k(e, build(p, fields)));
        if (r !== FAIL) return r;
      }
      if (far <= pos) { far = pos; farInfo = { kind: 'nt', name }; }
      return FAIL;
    } finally { active.delete(key); }
  }
  function build(p, fields) {
    const info = interp.variantIndex.get(p.name);
    if (!info) throw schemeError('sllgen: no datatype defines the variant ' + p.name + ' (run sllgen:make-define-datatypes, or define it with define-datatype)');
    if (info.fields.length !== fields.length) throw schemeError('sllgen: variant ' + p.name + ' has ' + info.fields.length + ' fields but the grammar gives ' + fields.length);
    return new Variant(info.dt, p.name, fields);
  }

  let result;
  try {
    result = nonterminal(spec.start, 0, (e, node) => {
      if (opts.prefix || e === tokens.length) return { node, end: e };
      if (e > leftover) leftover = e;
      return FAIL;
    });
  } catch (e) {
    if (e instanceof RangeError) throw schemeError('sllgen: input is nested too deeply to parse');
    throw e;
  }
  if (result === FAIL) {
    if (opts.prefix && !opts.final && (tokens.length === 0 || far >= tokens.length)) return null; // needs more input
    const where = (p) => 'parsing: at line ' + tok(p).line + ': ';
    const cur = (p) => tok(p).cls + ' ' + writeData(tok(p).data);
    if (leftover >= 0 && leftover >= far) throw schemeError(where(leftover) + 'symbols left over: ' + cur(leftover) + ' etc...');
    if (farInfo && farInfo.kind === 'nt') throw schemeError(where(far) + "nonterminal <" + farInfo.name + "> can't begin with " + cur(far));
    throw schemeError(where(far) + 'looking for ' + (farInfo ? farInfo.target : '?') + ', found ' + cur(far));
  }
  const restStart = result.end < tokens.length ? tokens[result.end].start : text.length;
  return { node: result.node, rest: text.slice(restStart) };
}

// ======================= datatype forms =======================
// Field names are the variant name plus a counter that is never reset, like the original's gensym.
function datatypeForms(interp, spec) {
  const preds = { symbol: 'symbol?', number: 'number?', string: 'string?' };
  const S = (n) => intern(n);
  const predOf = (it) => (it.t === 'tok' ? S(preds[it.kind]) : S(it.name + '?'));
  function predsOf(it) {
    if (it.t === 'lit') return [];
    if (it.t === 'tok' || it.t === 'nt') return [predOf(it)];
    const inner = [];
    for (const i of it.items) inner.push(...predsOf(i));
    return inner.map((p) => arrayToList([S('list-of'), p]));
  }
  const forms = [];
  for (const [nt, prods] of spec.byNt) {
    const variants = prods.map((p) => {
      const ps = [];
      for (const it of p.items) ps.push(...predsOf(it));
      return arrayToList([S(p.name), ...ps.map((pred) => arrayToList([gensym(interp, p.name), pred]))]);
    });
    forms.push(arrayToList([S('define-datatype'), S(nt), S(nt + '?'), ...variants]));
  }
  return forms;
}
