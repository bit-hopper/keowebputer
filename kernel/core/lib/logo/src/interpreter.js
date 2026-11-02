// The Logo interpreter object and the Job that runs one cell against it (LOGO.md 5.1, 5.3, 7.1).
//
// An Interpreter is one workspace: the table of primitives and user procedures, the global variables (held by its
// Machine), property lists, and the caches that make late parsing affordable. One Interpreter per wiki page; every logo
// and tpn cell on the page shares it (LOGO.md decision 1). A Job is one Run of one cell: it feeds the cell's lines to the
// machine a slice at a time so a long run can be interrupted, and turns what happens into the output segments the cell
// pane renders.
//
// Output segment kinds (the transcript pane's, PostCardUtils.js createSchemeOutput): stdout, error, warning, status.
// There is no 'value': a Logo cell does not echo expressions (LOGO.md decision 7). Errors carry no errorClass.

import { NIL, QWord, wordText, listFromArray, listToArray, nameKey } from './data.js';
import { LineReader, parseText } from './reader.js';
import { runparse } from './runparse.js';
import { treeify } from './treeify.js';
import { LogoError, err } from './errors.js';
import { showText } from './printer.js';
import { Machine, ByeSignal, ToplevelSignal, now } from './machine.js';
import { PrimTable, isPrimRecord } from './prims.js';
import { buildProc } from './procdef.js';
import * as arith from './arith.js';
import * as lists from './lists.js';
import * as control from './control.js';
import * as workspace from './workspace.js';
import * as turtleLib from './turtle.js';
import * as tpnLib from './tpn.js';

// The manual's "(library procedure)" entries that are implemented natively: user programs may redefine them.
const LIBRARY_PROCEDURES = 'ignore for do.while while do.until until case cond invoke foreach map map.se filter find reduce crossmap cascade cascade.2 transfer combine reverse gensym pick remove remdup quoted push pop queue dequeue localmake name namelist pllist iseq rseq backslashedp backslashed? ` mdarray mditem mdsetitem xcor ycor pen setpen erns erps erpls erall ern erpl poall pops pons popls pots';

const MAX_OUTPUT_CHARS = 1000000;

export class Interpreter {
  // opts: {prelude: source text of the always-loaded library, maxFrames, half: half-size of the turtle window (default 250)}
  constructor(opts = {}) {
    this.procs = new Map();        // key -> primitive record or Proc
    this.plists = new Map();       // plist name key -> Map(prop key -> [prop name, value])
    this.epoch = 0;                // bumped whenever a procedure is defined or erased: every cached tree is then stale
    this.treeCache = new WeakMap();
    this.textProcCache = new WeakMap();
    this.rng = Math.random;
    this.gensymCount = 0;
    this.systemVars = new Set();   // variables that exist from the start; NAMES / ERNS leave them alone
    this.buffer = '';              // output when no Job is attached (library loading, tests)
    this.turtle = new turtleLib.Turtle({ half: opts.half });   // the one turtle (LOGO.md decision 12) and its pending draw ops
    this.sink = null;
    this.machine = new Machine(this, { maxFrames: opts.maxFrames });
    const P = new PrimTable(this.procs);
    arith.install(P);
    lists.install(P);
    control.install(P);
    workspace.install(P);
    turtleLib.install(P);
    tpnLib.installPrims(this);   // after the Logo primitives it is built from
    for (const name of LIBRARY_PROCEDURES.split(/\s+/)) { const rec = this.procs.get(name); if (rec) rec.library = true; }
    this._initVars();
    if (opts.prelude) this.loadLibrary(opts.prelude);
  }

  _initVars() {
    // Read-only facts about this Logo (manual, SPECIAL VARIABLES; 11.5 item 6). LOGOPLATFORM is what the csls programs
    // branch on (LOGO.md 5.9); a fixed value for which they take their generic path.
    const set = (name, v) => { this.machine.vars.set(name, [{ v }]); this.systemVars.add(name); };
    set('logoversion', '6.2');
    set('logoplatform', 'Unix-Nographics');
    set('caseignoredp', 'true');
  }

  out(text) {
    if (this.sink !== null) this.sink(text); else this.buffer += text;
  }

  redefp() {
    const st = this.machine.vars.get('redefp');
    return !!st && st.length > 0 && typeof st[st.length - 1].v === 'string' && st[st.length - 1].v.toLowerCase() === 'true';
  }

  arityOf = (key) => {
    const p = this.procs.get(key);
    return p === undefined ? null : { min: p.min, def: p.def, max: p.max };
  };

  // ---- trees ------------------------------------------------------------------------------------------------------

  // The treeified instruction nodes of a list, cached against the list and the procedure epoch. A TPN block (tpn.js) is a
  // list registered with `fixed: true`: its nodes were made by the TPN analyser and are not Logo text to re-read, so they are
  // never stale (the procedure that owns them is analysed afresh, with new blocks, when the epoch changes).
  getTree(list) {
    if (list === NIL) return [];
    const cached = this.treeCache.get(list);
    if (cached !== undefined && (cached.fixed || cached.epoch === this.epoch)) return cached.nodes;
    const nodes = treeify(runparse(listToArray(list)), this.arityOf);
    this.treeCache.set(list, { epoch: this.epoch, nodes });
    return nodes;
  }

  // Nodes for a line of items as the reader produced them (a top-level instruction line).
  lineNodes(items) { return treeify(runparse(items), this.arityOf); }

  // A procedure's body as flat instruction nodes, each carrying .line (the body line it came from) for error messages.
  bodyNodes(proc) {
    if (proc.nodes !== null && proc.nodesEpoch === this.epoch) return proc.nodes;
    if (proc.dialect === 'tpn') {
      proc.nodes = tpnLib.compileProcBody(this, proc);
      proc.nodesEpoch = this.epoch;
      return proc.nodes;
    }
    const nodes = [];
    for (const line of proc.lines) {
      const ns = treeify(runparse(listToArray(line)), this.arityOf);
      for (const n of ns) { n.line = line; nodes.push(n); }
    }
    proc.nodes = nodes; proc.nodesEpoch = this.epoch;
    return nodes;
  }

  parseWord(w) { return listFromArray(parseText(wordText(w))); }

  // A procedure-text template [[x y] [line] [line]] as an anonymous procedure, built once per template list.
  procedureFromText(tpl, who) {
    let p = this.textProcCache.get(tpl);
    if (p === undefined) {
      p = buildProc(who, listToArray(tpl.first), listToArray(tpl.rest), null);
      this.textProcCache.set(tpl, p);
    }
    return p;
  }

  // ---- definitions --------------------------------------------------------------------------------------------------

  // Installs a user procedure. Throws "X is a primitive" for a primitive's name unless REDEFP is true. Returns 'defined'
  // for a new name and 'redefined' when it replaced a user procedure. `redefine: false` makes an existing user procedure
  // an "already defined" error (LOGO.md decision 15, ;# strict).
  installProc(proc, opts = {}) {
    const existing = this.procs.get(proc.key);
    // A library procedure (native or from the prelude) is the language's, not the program's: a program replacing it is
    // defining a new procedure, so it reports 'defined' (as the reference does for csls's own `quoted` and `remove`) and
    // is never an "already defined" error. Only a procedure some program defined counts as user-defined.
    const userDefined = existing !== undefined && !isPrimRecord(existing) && !existing.library;
    if (existing !== undefined) {
      const isPrim = isPrimRecord(existing);
      if (isPrim && !this.redefp()) throw err.isPrimitive(proc.name);
      if (userDefined && opts.redefine === false) throw err.alreadyDefined(proc.name);
    }
    if (opts.library) proc.library = true;
    if (opts.owner !== undefined) proc.owner = opts.owner;
    this.procs.set(proc.key, proc);
    this.epoch++;
    return userDefined ? 'redefined' : 'defined';
  }

  copyProc(newName, old) {
    const key = nameKey(newName);
    const existing = this.procs.get(key);
    if (existing !== undefined && isPrimRecord(existing) && !this.redefp()) throw err.isPrimitive(newName);
    const copy = Object.assign(Object.create(Object.getPrototypeOf(old)), old);
    copy.name = newName; copy.key = key;
    if (copy.nodes !== undefined) { copy.nodes = null; copy.nodesEpoch = -1; }
    this.procs.set(key, copy);
    this.epoch++;
  }

  eraseProc(name) {
    this.procs.delete(nameKey(name));
    this.epoch++;
  }

  // ---- running ----------------------------------------------------------------------------------------------------

  // Defines `source`'s procedures and runs its instruction lines to completion, silently, as the always-loaded library.
  // Every procedure it defines is marked library (not listed by PROCEDURES, not erased by ERALL).
  loadLibrary(source) {
    const job = new Job(this, source, { library: true });
    for (;;) {
      const r = job.step(1e9);
      if (r.state === 'error') throw new Error('library failed to load: ' + r.segments.map((s) => s.text).join(' | '));
      if (r.state !== 'running') break;
    }
    this.buffer = '';
  }

  // Convenience for tests and tools: run `source` to the end and return {state, segments, text, draw, turtle}, where text
  // renders the segments the way the reference's terminal would show them (stdout as is; status and error lines
  // newline-terminated), draw is every draw operation the run emitted and turtle the turtle's last reported state.
  run(source, opts = {}) {
    const job = new Job(this, source, opts);
    const segments = [], draw = [];
    let state = 'running', turtle = null;
    while (state === 'running') {
      const r = job.step(1e9);
      state = r.state;
      segments.push(...r.segments);
      for (const op of r.draw) draw.push(op);   // not push(...): a slice can hold hundreds of thousands of operations
      if (r.turtle !== null) turtle = r.turtle;
    }
    return { state, segments, text: renderSegments(segments), draw, turtle };
  }

  startRun(source, opts = {}) { return new Job(this, source, opts); }
}

export function renderSegments(segments) {
  let t = '';
  for (const s of segments) {
    if (s.kind === 'stdout') t += s.text;
    else t += s.text + '\n';
  }
  return t;
}

// ---------------------------------------------------------------------------------------------------------------------

const isEndLine = (items) => items.length === 1 && typeof items[0] === 'string' && items[0].toLowerCase() === 'end';
const isToLine = (items) => items.length > 0 && typeof items[0] === 'string' && (items[0].toLowerCase() === 'to' || items[0].toLowerCase() === '.macro');

export class Job {
  // opts: {onError: 'stop' (default; an uncaught error ends the cell) | 'continue' (like the Logo prompt: report it and
  //        go on with the next line), library: define silently, quiet: no "defined" lines, strict: no redefinition,
  //        dialect: 'logo' (default) | 'tpn', the surface syntax of this cell's source (LOGO.md 4.4); procedures it defines
  //        record it}
  constructor(interp, source, opts = {}) {
    this.interp = interp;
    this.opts = opts;
    this.dialect = opts.dialect === 'tpn' ? 'tpn' : 'logo';   // anything else is Logo, so a stray value cannot select nothing
    this.reader = this.dialect === 'tpn' ? new tpnLib.TpnReader(interp, source) : new LineReader(source);
    this.segments = [];
    this.sinceDrain = 0;
    this.out = '';
    this.outTotal = 0;
    this.truncated = false;
    this.state = 'running';     // running | done | error | stopped | exit
    this.cancelled = false;
    this.active = false;        // a line is mid-evaluation in the machine
  }

  interrupt() { this.cancelled = true; this.interp.machine.cancelled = true; }

  drain() {
    const out = this.segments.slice(this.sinceDrain);
    this.sinceDrain = this.segments.length;
    return out;
  }

  _flush() {
    if (this.out === '') return;
    const last = this.segments[this.segments.length - 1];
    if (last && last.kind === 'stdout' && this.sinceDrain <= this.segments.length - 1) last.text += this.out;
    else this.segments.push({ kind: 'stdout', text: this.out });
    this.out = '';
  }
  _push(kind, text, extra) { this._flush(); this.segments.push(Object.assign({ kind, text }, extra)); }
  _finish(state) {
    this._flush();
    if (this.truncated) this.segments.push({ kind: 'status', text: '(output truncated)' });
    if (this.interp.turtle.takeCapNotice()) this.segments.push({ kind: 'status', text: '(drawing truncated: too many operations; CLEAN or CLEARSCREEN starts a new picture)' });
    this.state = state;
  }
  _sink(text) {
    if (this.truncated) return;
    this.outTotal += text.length;
    if (this.outTotal > MAX_OUTPUT_CHARS) { this.truncated = true; return; }
    this.out += text;
  }

  // Runs for roughly `budgetMs`; returns {state, segments, draw, turtle}: the new segments since the last call, the draw
  // operations emitted meanwhile, and the turtle's state if it changed (else null).
  step(budgetMs = 25) {
    const interp = this.interp;
    if (this.state === 'running') {
      interp.sink = (t) => this._sink(t);
      try {
        this._loop(now() + budgetMs);
      } catch (e) {
        interp.machine.abandon();
        this.active = false;
        this._push('error', 'Internal error: ' + (e && e.message ? e.message : String(e)));
        this._finish('error');
      } finally {
        interp.sink = null;
      }
    }
    // Draw operations and (when it changed) the turtle's state go out with the same slice as the text (LOGO.md 7.1).
    const g = interp.turtle.drain();
    return { state: this.state, segments: this.drain(), draw: g.ops, turtle: g.turtle };
  }

  _loop(deadline) {
    const interp = this.interp, m = interp.machine;
    const continueOnError = this.opts.onError === 'continue';
    while (this.state === 'running') {
      if (!this.active) {
        if (this.cancelled) { this._finish('stopped'); return; }
        let line;
        try {
          line = this.reader.readLine();
        } catch (e) {
          if (!(e instanceof LogoError)) throw e;
          this._reportError(e);
          if (!continueOnError) { this._finish('error'); return; }
          continue;
        }
        if (line === null) { this._finish('done'); return; }
        if (line.tpn !== undefined) {
          // A TPN cell: a definition, or one statement already analysed into nodes (tpn.js TpnReader).
          if (line.tpn.kind === 'to') {
            if (!this._defineTpn(line.tpn.line)) { if (!continueOnError) { this._finish('error'); return; } }
            continue;
          }
          m.cancelled = false;
          interp.turtle.filling = null;
          m.begin([line.tpn.node]);
          this.active = true;
        } else {
          if (line.items.length === 0) continue;
          if (isToLine(line.items)) {
            if (!this._define(line)) { if (!continueOnError) { this._finish('error'); return; } }
            continue;
          }
          m.cancelled = false;
          interp.turtle.filling = null;   // a FILLED abandoned by an error in an earlier line is not still running
          m.begin(interp.lineNodes(line.items));
          this.active = true;
        }
      }
      let r;
      try {
        r = m.run(deadline);
      } catch (e) {
        m.abandon();
        this.active = false;
        if (e instanceof LogoError) {
          this._reportError(e);
          if (!continueOnError) { this._finish('error'); return; }
          continue;
        }
        if (e instanceof ToplevelSignal) continue;
        if (e instanceof ByeSignal) { this._finish('exit'); return; }
        throw e;
      }
      if (r === 'done') {
        this.active = false;
        if (now() > deadline) return;
        continue;
      }
      // 'running': the slice is over, or Stop was pressed.
      if (this.cancelled) { m.abandon(); this.active = false; this._finish('stopped'); return; }
      return;
    }
  }

  _reportError(e) {
    if (e.quiet) return;   // an ERRACT handler read the error with ERROR, which consumes it (Machine.startErract)
    let text = e.message;
    if (e.proc !== null && e.proc !== undefined && e.proc !== '') {
      text += '  in ' + e.proc;
      if (e.line !== null && e.line !== undefined) text += '\n' + showText(e.line);
    }
    this._push('error', text);
  }

  // A TPN title line (with its indented body under it) has been read: build the procedure, check its body for syntax errors
  // now (the nodes are thrown away: they are analysed again when it is first called, once the procedures it uses exist),
  // and install it. Returns false after reporting an error.
  _defineTpn(titleLine) {
    const interp = this.interp;
    try {
      const proc = tpnLib.buildTpnProc(titleLine);
      tpnLib.compileProcBody(interp, proc);
      const status = tpnLib.installTpnProc(interp, proc, {
        redefine: this.opts.strict ? false : true, library: !!this.opts.library, owner: this.opts.owner,
      });
      if (!this.opts.library && !this.opts.quiet) this._push('status', proc.name + ' ' + status, { tone: 'note' });
      return true;
    } catch (e) {
      if (!(e instanceof LogoError)) throw e;
      this._reportError(e);
      return false;
    }
  }

  // A TO line has been read; read the body up to END and install the procedure. Returns false after reporting an error.
  _define(line) {
    const interp = this.interp;
    const body = [], raw = [line.raw];
    let ended = false;
    for (;;) {
      let l;
      try {
        l = this.reader.readLine();
      } catch (e) {
        if (!(e instanceof LogoError)) throw e;
        this._reportError(e);   // a stray bracket in a body line: say so, keep reading the definition
        continue;
      }
      if (l === null) break;
      if (isEndLine(l.items)) { raw.push(l.raw); ended = true; break; }
      if (l.items.length === 0) continue;
      body.push(l.items);
      raw.push(l.raw);
    }
    if (!ended) raw.push('end');
    const titleItems = line.items.slice(1);
    try {
      if (titleItems.length === 0 || !(typeof titleItems[0] === 'string' || titleItems[0] instanceof QWord)) throw err.tooFew('to');
      const name = wordText(titleItems[0]);
      const proc = buildProc(name, titleItems.slice(1), body.map((items) => listFromArray(items)), raw);
      proc.isMacro = line.items[0].toLowerCase() === '.macro';
      proc.dialect = this.dialect;
      const status = interp.installProc(proc, {
        redefine: this.opts.strict ? false : true, library: !!this.opts.library, owner: this.opts.owner,
      });
      if (!this.opts.library && !this.opts.quiet) this._push('status', name + ' ' + status, { tone: 'note' });
      return true;
    } catch (e) {
      if (!(e instanceof LogoError)) throw e;
      this._reportError(e);
      return false;
    }
  }
}
