// The public interface of the engine (MLspec.md sections 5.7, 6.7): the same two classes as the Scheme engine.
//
//   const interp = new Interpreter();
//   const job = interp.startRun(source);
//   for (;;) { const { state, segments } = job.step(25); ...; if (state !== 'running') break; }   // or job.runToCompletion()
//   job.interrupt();   // cooperative; seen between slices; the environment keeps everything defined before it
//
// A cell is a REPL transcript: each item is parsed, elaborated, checked and run before the next is read, so later items see
// earlier definitions and an error stops the cell with everything before it kept. Segments:
//   {kind:'value', text}                       a declaration echo or `val it = V : T`
//   {kind:'warning', text, line, col}          non-exhaustive match (and a redundant one when the page demotes it)
//   {kind:'error', errorClass, text, line, col}
//   {kind:'status', text, tone}                verdicts, `Stopped`, `(output truncated)`; tone: ok | note | bad
//   {kind:'stdout', text}                      what `print` wrote (consecutive writes are one segment)
// Job states: running | done | error | stopped.
import { MLError } from './errors.js';
import { Parser } from './parser.js';
import { derive } from './derive.js';
import { Elaborator } from './infer.js';
import { makeBasis } from './basis.js';
import { checkMatchSites } from './patterns.js';
import { ItemRun, makeGlobals } from './machine.js';
import { prune, typeToString } from './types.js';
import { showValue, echoText, DEFAULT_DEPTH, DEFAULT_LENGTH } from './printer.js';

const OUTPUT_CAP = 1000000;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Are two types the same up to renaming of their variables?
function alphaEqual(a, b) {
  const ab = new Map();
  const ba = new Map();
  const go = (x, y) => {
    x = prune(x);
    y = prune(y);
    if (x.tag !== y.tag) return false;
    switch (x.tag) {
      case 'var':
        if (x.eq !== y.eq) return false;
        if (ab.has(x)) return ab.get(x) === y;
        if (ba.has(y)) return false;
        ab.set(x, y);
        ba.set(y, x);
        return true;
      case 'fn': return go(x.from, y.from) && go(x.to, y.to);
      case 'tuple': return x.items.length === y.items.length && x.items.every((it, i) => go(it, y.items[i]));
      case 'con': return x.name === y.name && x.args.every((it, i) => go(it, y.args[i]));
      default: return false;
    }
  };
  return go(a, b);
}

// The part of the basis that is ML source, because a JavaScript primitive cannot apply a closure (map) and these are three lines
// each. Run once, silently, into every interpreter that has the lists-and-strings basis; a program may redefine any of them.
const PRELUDE = `
fun map f nil = nil
  | map f (x :: xs) = f x :: map f xs;
fun isSome NONE = false | isSome (SOME _) = true;
fun valOf (SOME x) = x | valOf NONE = raise Option;
`;

export class Interpreter {
  // settings: style 'book' | 'sml', depth, length, verdicts, redundant (the pragmas of MLspec.md section 5.9), and
  // basis 'full' (the default: lists, strings, print and the rest of makeBasis) | 'core' (only what chapters 1-10 of the
  // book use, the engine as it was before the lists phase).
  constructor(settings = {}) {
    this.settings = { style: 'book', depth: DEFAULT_DEPTH, length: DEFAULT_LENGTH, verdicts: true, redundant: 'error', basis: 'full', ...settings };
    const full = this.settings.basis !== 'core';
    this.scope = makeBasis({ lists: full }).child();
    this.globals = makeGlobals();
    this.elaborator = new Elaborator({ style: this.settings.style });
    if (full) {
      const r = this.startRun(PRELUDE).runToCompletion();
      if (r.state !== 'done') throw new Error('ML prelude failed: ' + JSON.stringify(r.segments));
    }
  }

  startRun(source) { return new Job(this, source); }

  evalSync(source) { return this.startRun(source).runToCompletion(); }
}

export class Job {
  constructor(interp, source) {
    this.interp = interp;
    this.parser = new Parser(source);
    this.state = 'running';
    this.segments = [];
    this.cur = null; // the item being run: { item, elaborated, run }
    this.interruptFlag = false;
    this.emitted = 0;
    this.truncated = false;
  }

  interrupt() {
    this.interruptFlag = true;
    if (this.cur) this.cur.run.interrupt();
  }

  drain() {
    const out = this.segments;
    this.segments = [];
    return out;
  }

  runToCompletion() {
    const all = [];
    for (;;) {
      const { state, segments } = this.step(1e9);
      all.push(...segments);
      if (state !== 'running') return { state, segments: all };
    }
  }

  push(seg) {
    if (this.truncated) {
      // past the cap what grows without bound (printing, echo lines, warnings) is dropped, but the lines that say how the cell
      // ended -- an error, `Stopped`, a verdict -- are small, bounded by the source, and must still get through
      if (seg.kind === 'error' || seg.kind === 'status') this.segments.push(seg);
      return;
    }
    this.emitted += (seg.text || '').length;
    if (this.emitted > OUTPUT_CAP) {
      this.truncated = true;
      this.segments.push({ kind: 'status', text: '(output truncated)', tone: 'note' });
      return;
    }
    const last = this.segments[this.segments.length - 1];
    if (seg.kind === 'stdout' && last && last.kind === 'stdout') last.text += seg.text; // (a print loop is one segment, not a million)
    else this.segments.push(seg);
  }

  fail(e) {
    if (e.errorClass === undefined) throw e;
    this.push({ kind: 'error', errorClass: e.errorClass, text: e.message, line: e.line, col: e.col });
    this.state = 'error';
  }

  step(budgetMs) {
    const deadline = now() + budgetMs;
    while (this.state === 'running') {
      if (this.interruptFlag && !this.cur) { this.stopped(); break; }
      if (!this.cur) {
        this.nextItem();
        continue;
      }
      const st = this.cur.run.step(Math.max(1, deadline - now()));
      if (st !== 'running') this.finishItem(st);
      else if (now() >= deadline) break;
    }
    return { state: this.state, segments: this.drain() };
  }

  stopped() {
    this.push({ kind: 'status', text: 'Stopped', tone: 'note' });
    this.state = 'stopped';
  }

  // ---- one item, up to the point where the machine runs --------------------------------------------------------

  nextItem() {
    const { interp } = this;
    let item;
    try {
      item = this.parser.nextItem();
    } catch (e) { this.fail(e); return; }
    if (!item) { this.state = 'done'; return; }

    if (item.kind === 'pragma') { this.pragma(item); return; }
    if (item.kind === 'bad') { this.verdictRejected(item.error); return; } // a ⊗ box that is not even grammatical

    interp.elaborator.style = interp.settings.style;
    try {
      if (!item.expectRejected && this.typeBox(item)) return;
      const elaborated = interp.elaborator.elaborateItem(derive(item), interp.scope);
      const checked = checkMatchSites(elaborated.matchSites, {
        style: interp.settings.style, redundantAsWarning: interp.settings.redundant === 'warning',
      });
      if (checked.error) throw checked.error;
      for (const w of checked.warnings) this.push({ kind: 'warning', text: w.message, line: w.line, col: w.col });
      const out = (text) => this.push({ kind: 'stdout', text });
      this.cur = { item, elaborated, run: new ItemRun(elaborated.ir, interp.globals, { out }) };
      if (this.interruptFlag) this.cur.run.interrupt();
    } catch (e) {
      if (e.errorClass === undefined) throw e;
      if (item.expectRejected) this.verdictRejected(e); else this.fail(e);
    }
  }

  pragma(item) {
    const s = this.interp.settings;
    const v = item.value.trim();
    switch (item.name) {
      case 'style':
        if (v === 'book' || v === 'sml') s.style = v; else this.push({ kind: 'warning', text: 'style is book or sml, not ' + v });
        break;
      case 'depth': {
        const n = Number(v);
        if (Number.isInteger(n) && n > 0) s.depth = n; else this.push({ kind: 'warning', text: 'depth is a positive integer, not ' + v });
        break;
      }
      case 'length': {
        const n = Number(v);
        if (Number.isInteger(n) && n > 0) s.length = n; else this.push({ kind: 'warning', text: 'length is a positive integer, not ' + v });
        break;
      }
      case 'verdicts':
        if (v === 'on' || v === 'off') s.verdicts = v === 'on'; else this.push({ kind: 'warning', text: 'verdicts is on or off, not ' + v });
        break;
      case 'redundant':
        if (v === 'error' || v === 'warning') s.redundant = v; else this.push({ kind: 'warning', text: 'redundant is error or warning, not ' + v });
        break;
      default: this.push({ kind: 'warning', text: 'unknown pragma ' + item.name });
    }
  }

  // The book's ⊗: "this box is rejected". Reporting the claim never stops the cell.
  verdictRejected(e) {
    this.push({ kind: 'status', tone: 'ok', text: '✓ rejected as the book says (' + e.errorClass + '): ' + e.message });
  }

  // `( name : type )` is how the book's type boxes are transcribed. In book mode it gets a verdict instead of `val it`.
  // Returns true if the item was handled here.
  typeBox(item) {
    const { interp } = this;
    if (!interp.settings.verdicts || interp.settings.style !== 'book') return false;
    if (item.kind !== 'expstmt' || item.exp.kind !== 'typed' || item.exp.exp.kind !== 'var') return false;
    const ref = item.exp.exp;
    const shown = (ref.qual ? ref.qual.join('.') + '.' : '') + ref.name;
    let info = null;
    if (ref.qual) {
      interp.elaborator.scope = interp.scope;
      try { info = interp.elaborator.lookupQualVal(ref); } catch (e) { if (!(e instanceof MLError)) throw e; }
    } else info = interp.scope.lookupVal(ref.name);
    if (!info) return false; // an unknown name: the ordinary path reports it
    const principal = typeToString(info.scheme, 'book', new Map());
    try {
      const r = interp.elaborator.elaborateItem(derive(item), interp.scope);
      const asserted = r.echo[0].type;
      if (alphaEqual(asserted, info.scheme)) {
        this.push({ kind: 'status', tone: 'ok', text: '✓ exactly: ' + shown + ' : ' + principal });
      } else {
        this.push({
          kind: 'status', tone: 'note',
          text: '≈ the actual type is more general: ' + shown + ' : ' + principal + ' (you asserted ' + typeToString(asserted, 'book', new Map()) + ')',
        });
      }
    } catch (e) {
      if (!(e instanceof MLError) || e.errorClass !== 'nonsense') throw e;
      this.push({ kind: 'status', tone: 'bad', text: '✗ nonsense: ' + e.message + '; the actual type of ' + shown + ' is ' + principal });
    }
    return true;
  }

  // ---- after the machine has run the item ----------------------------------------------------------------------

  finishItem(st) {
    const { interp } = this;
    const { item, elaborated, run } = this.cur;
    this.cur = null;
    if (st === 'stopped') { this.stopped(); return; }
    if (item.expectRejected) {
      // statically accepted although the book marks the box ⊗
      this.push({ kind: 'status', tone: 'bad', text: '✗ accepted — the book marks this box ⊗' });
      if (st === 'done') { run.commit(); elaborated.scope.mergeInto(interp.scope); }
      return;
    }
    if (st === 'done') {
      run.commit();
      elaborated.scope.mergeInto(interp.scope);
      const valueOf = (name) => interp.globals.get(name).value;
      for (const entry of elaborated.echo) this.push({ kind: 'value', text: echoText(entry, valueOf, interp.settings.style, interp.settings.depth, interp.settings.length) });
      return;
    }
    if (st === 'raised') {
      this.push({ kind: 'error', errorClass: 'exception', text: 'uncaught exception ' + showValue(run.exn, interp.settings.style, interp.settings.depth, interp.settings.length) });
    } else if (run.limitReason === 'memory') {
      this.push({ kind: 'error', errorClass: 'limit', text: 'a string or a list grew past what this page can hold, so this has no value' });
    } else {
      this.push({ kind: 'error', errorClass: 'limit', text: 'the recursion went too deep (more than ' + run.maxDepth + ' frames), so this has no value' });
    }
    this.state = 'error';
  }
}
