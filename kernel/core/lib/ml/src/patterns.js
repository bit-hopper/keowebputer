// The pattern checker (MLspec.md section 6.4): exhaustiveness and redundancy of every match the elaborator saw.
//
//   const { warnings, error } = checkMatchSites(elaborated.matchSites, { style: 'book', redundantAsWarning: false });
//
// Input is `Elaborator#elaborateItem(...).matchSites`, a list of {kind:'fn'|'handle'|'val', origin, loc, ruleLocs, ty, rules}
// whose rules are pattern IR: {p:'wild'} {p:'var'} {p:'int', value} {p:'con', con, arg|null} {p:'exn', name, arg|null}
// {p:'tuple', items}.  (str and chr constants, like int ones, form an infinite signature.)
//
//   - a rule that no value can reach is REDUNDANT: an error of class 'redundant' (SML/NJ rejects it too), or a warning
//     when `redundantAsWarning` is set (MLspec.md decision B);
//   - a match that some value escapes is NON-EXHAUSTIVE: a warning listing example values it misses. A `handle` is never
//     reported (an unmatched exception is simply re-raised), and a `seq` fn is always exhaustive.
//
// The algorithm is the usual usefulness matrix over constructor signatures: a datatype's constructors are all listed in
// `con.tyname.cons`; a tuple is a single constructor; `int` constants and exception constructors form infinite signatures.
// The caller runs this after `elaborateItem` succeeds and before the item is evaluated, so an error means nothing was defined.
import { MLError } from './errors.js';
import { prune } from './types.js';

const WILD = { k: 'wild' };

// ---- constructors of a pattern ---------------------------------------------------------------------------------

// The head constructor of a pattern, or null for a wildcard/variable. `sig` is the number of constructors in its
// signature (null: infinitely many).
function head(p) {
  switch (p.p) {
    case 'wild': case 'var': return null;
    case 'int': return { key: 'i' + p.value, kind: 'int', arity: 0, sig: null, value: p.value };
    case 'str': return { key: 's' + p.value, kind: 'str', arity: 0, sig: null, value: p.value };
    case 'chr': return { key: 'h' + p.value, kind: 'chr', arity: 0, sig: null, value: p.value };
    case 'con': return {
      key: 'c' + p.con.index, kind: 'con', arity: p.arg ? 1 : 0, sig: p.con.tyname.cons.length, name: p.con.name, tyname: p.con.tyname,
    };
    case 'exn': return { key: 'e' + (p.qual ? p.qual.join('.') + '.' : '') + p.name, kind: 'exn', arity: p.arg ? 1 : 0, sig: null, name: p.name };
    case 'tuple': return { key: 't', kind: 'tuple', arity: p.items.length, sig: 1 };
    default: throw new MLError('internal', 'patterns: unknown pattern ' + p.p);
  }
}

const subpatterns = (p) => {
  switch (p.p) {
    case 'con': case 'exn': return p.arg ? [p.arg] : [];
    case 'tuple': return p.items;
    default: return [];
  }
};

const wilds = (n) => Array.from({ length: n }, () => ({ p: 'wild' }));

// The rows that can match a value built with constructor `h`, with that constructor's fields spliced in front.
function specialise(rows, h) {
  const out = [];
  for (const row of rows) {
    const rh = head(row[0]);
    if (rh === null) out.push(wilds(h.arity).concat(row.slice(1)));
    else if (rh.key === h.key) out.push(subpatterns(row[0]).concat(row.slice(1)));
  }
  return out;
}

const defaultRows = (rows) => rows.filter((row) => head(row[0]) === null).map((row) => row.slice(1));

// The distinct head constructors of the first column, and whether they cover their whole signature.
function column(rows) {
  const heads = new Map();
  for (const row of rows) {
    const h = head(row[0]);
    if (h && !heads.has(h.key)) heads.set(h.key, h);
  }
  const first = heads.values().next().value;
  const complete = !!first && first.sig !== null && heads.size === first.sig;
  return { heads, complete };
}

// ---- usefulness (is there a value `q` matches that no row does?) ---------------------------------------------------

function useful(rows, q) {
  if (q.length === 0) return rows.length === 0;
  const h = head(q[0]);
  if (h) return useful(specialise(rows, h), subpatterns(q[0]).concat(q.slice(1)));
  const { heads, complete } = column(rows);
  if (complete) {
    for (const c of heads.values()) {
      if (useful(specialise(rows, c), wilds(c.arity).concat(q.slice(1)))) return true;
    }
    return false;
  }
  return useful(defaultRows(rows), q.slice(1));
}

// ---- witnesses (values the rows miss) ----------------------------------------------------------------------------

function build(h, subs) {
  switch (h.kind) {
    case 'int': case 'str': case 'chr': return { k: h.kind, value: h.value };
    case 'tuple': return { k: 'tuple', items: subs };
    default: return { k: 'con', name: h.name, args: subs };
  }
}

// The wildcard for a value of type `t`: `_`, or `(_,_)` when it is a tuple, so a missing `C of t * t` shows its shape.
function anything(t) {
  t = prune(t);
  return t.tag === 'tuple' && t.items.length > 1 ? { k: 'tuple', items: t.items.map(anything) } : WILD;
}

// Up to `limit` vectors of length `n` that no row matches.
function witnesses(rows, n, limit) {
  if (n === 0) return rows.length === 0 ? [[]] : [];
  const { heads, complete } = column(rows);
  const out = [];
  if (complete) {
    for (const c of heads.values()) {
      for (const w of witnesses(specialise(rows, c), c.arity + n - 1, limit)) {
        out.push([build(c, w.slice(0, c.arity))].concat(w.slice(c.arity)));
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
  const rest = witnesses(defaultRows(rows), n - 1, limit);
  if (rest.length === 0) return out;
  const first = heads.values().next().value;
  if (first && first.kind === 'con') { // finite, incomplete: name the constructors that are missing
    for (const c of first.tyname.cons) {
      if (heads.has('c' + c.info.index)) continue;
      for (const w of rest) {
        out.push([{ k: 'con', name: c.name, args: c.info.hasArg ? [anything(c.ty)] : [] }].concat(w)); // a pair argument shows as (_,_)
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
  for (const w of rest) { // no constructor in the column, or an infinite signature (int, exn): any other value will do
    out.push([WILD].concat(w));
    if (out.length >= limit) return out;
  }
  return out;
}

// ---- showing a witness ---------------------------------------------------------------------------------------------

export function showWitness(w, style = 'book') {
  switch (w.k) {
    case 'wild': return '_';
    case 'int': return w.value < 0 ? '~' + (-w.value) : String(w.value);
    case 'str': return JSON.stringify(w.value);
    case 'chr': return '#' + JSON.stringify(w.value);
    case 'tuple': return '(' + w.items.map((x) => showWitness(x, style)).join(',') + ')';
    case 'con': {
      if (w.args.length === 0) return w.name === 'nil' ? '[]' : w.name;
      const arg = w.args[0];
      if (w.name === '::' && arg.k === 'tuple' && arg.items.length === 2) { // a list reads  x :: rest
        const side = (x) => (x.k === 'con' && x.name === '::' && x.args.length ? '(' + showWitness(x, style) + ')' : showWitness(x, style));
        return side(arg.items[0]) + ' :: ' + showWitness(arg.items[1], style);
      }
      if (style === 'book') return arg.k === 'tuple' ? w.name + showWitness(arg, style) : w.name + '(' + showWitness(arg, style) + ')';
      const atomic = arg.k === 'wild' || arg.k === 'tuple' || arg.k === 'int' || (arg.k === 'con' && arg.args.length === 0);
      return w.name + ' ' + (atomic ? showWitness(arg, style) : '(' + showWitness(arg, style) + ')');
    }
    default: return '?';
  }
}

// ---- checking a whole item ---------------------------------------------------------------------------------------

const MAX_WITNESSES = 4;

function subject(site) {
  const o = site.origin;
  if (site.kind === 'handle') return 'this handler';
  if (site.kind === 'val') return 'this val pattern';
  if (o && o.kind === 'fun') return o.name;
  if (o && o.kind === 'case') return 'this case expression';
  return 'this fn';
}

function ruleWord(site) {
  return site.origin && site.origin.kind === 'fun' ? 'clause' : 'rule';
}

function list(items) {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

// -> { warnings: [{kind:'nonexhaustive'|'redundant', message, line, col, ...}], error: MLError|null }
export function checkMatchSites(sites, options = {}) {
  const style = options.style || 'book';
  const warnings = [];
  let error = null;
  const where = (loc) => (loc ? { line: loc.line, col: loc.col, start: loc.start, end: loc.end } : {});

  for (const site of sites) {
    if (site.origin && site.origin.kind === 'seq') continue;
    const rules = site.rules;

    // a rule no value can reach
    for (let i = 1; i < rules.length; i++) {
      if (useful(rules.slice(0, i).map((r) => [r]), [rules[i]])) continue;
      const loc = (site.ruleLocs && site.ruleLocs[i]) || site.loc;
      const earlier = i === 1 ? 'the ' + ruleWord(site) + ' before it already matches' : 'the ' + ruleWord(site) + 's before it already match';
      const message = ruleWord(site) + ' ' + (i + 1) + ' of ' + subject(site) + ' can never be used: ' + earlier + ' everything it matches';
      if (options.redundantAsWarning) warnings.push({ kind: 'redundant', message, ...where(loc) });
      else if (!error) error = new MLError('redundant', message, loc);
    }

    // a value no rule matches (an unmatched handler re-raises, so a handler is never reported)
    if (site.kind === 'handle') continue;
    const missing = witnesses(rules.map((r) => [r]), 1, MAX_WITNESSES + 1).map((w) => showWitness(w[0], style));
    if (missing.length === 0) continue;
    const shown = missing.slice(0, MAX_WITNESSES);
    const more = missing.length > MAX_WITNESSES ? ' and others' : '';
    const effect = site.kind === 'val' ? 'a value like that raises Bind' : 'a value like that raises Match';
    const message = site.kind === 'val'
      ? subject(site) + ' does not match every value, for example ' + list(shown) + more + '; ' + effect
      : subject(site) + ' has no ' + ruleWord(site) + ' for ' + list(shown) + more + '; ' + effect;
    warnings.push({ kind: 'nonexhaustive', message, ...where(site.loc) });
  }
  return { warnings, error };
}
