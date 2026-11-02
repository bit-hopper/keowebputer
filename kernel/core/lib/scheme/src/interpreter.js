// The public face of the engine: Interpreter (global state) and Job (one
// run of a cell's source, executed in time slices so the host can interleave
// Stop / input / other messages).
import {
  UNSPEC, UNBOUND, EOF, Box, Port, Environment, Values, SchemeThrow, SchemeAbort, SchemeExit,
  intern, stripSym,
} from './types.js';
import { Parser } from './reader.js';
import { Machine, STATUS, setMaxDepth } from './machine.js';
import { Compiler, SF, nativeMacros } from './compiler.js';
import { installPrimitives } from './primitives.js';
import { installControl } from './control.js';
import { installEopl } from './eopl.js';
import { toWrite, uncaughtReport, printSettings } from './printer.js';

const MAX_OUTPUT_CHARS = 1_000_000;
// Names that are accepted as `#lang` without a registered library.
const BUILTIN_LANGS = new Set(['scheme', 'r7rs', 'r5rs', 'mit-scheme', 'core']);
// Libraries that redefine core names (if, car, +, ...) with a different meaning. Compiled in system
// mode they would change what library procedures such as map and sort do, so they are loaded as
// user code instead: the change is page-wide until Reset, like any definition a cell makes.
const USER_MODE_LIBRARIES = new Set(['jbob']);

export class Interpreter {
  constructor(opts = {}) {
    this.sysGlobals = new Map();
    this.userGlobals = this.sysGlobals; // split by seal()
    this.systemMode = true;
    this.specials = new Map();
    this.macros = new Map();
    this.primTable = new Map();
    this.globalEnv = new Environment('system-global-environment');
    this.datatypes = new Map();   // define-datatype: type name -> DataType
    this.variantIndex = new Map(); // variant name -> {dt, fields} (sllgen builds trees through it)
    this.libraries = new Map();   // name -> source text
    this.loadedLibraries = new Set();
    this.consoleOut = new Port('console-out');
    this.consoleIn = new Port('console-in');
    this.textNumbers = false;     // arithmetic accepts text that reads as a number (switched on by the word library)
    this.runCount = 0;           // top-level runs started so far (library state that must not outlive an aborted run)
    this.currentOut = this.consoleOut;
    this.sink = null;
    if (opts.maxDepth) setMaxDepth(opts.maxDepth);
    if (opts.abbreviateQuote !== undefined) printSettings.abbreviateQuote = opts.abbreviateQuote;
    this.machine = new Machine(this);
    this.compiler = new Compiler(this);

    for (const sf of Object.values(SF)) this.specials.set(intern(sf.name), sf);
    for (const [name, macro] of Object.entries(nativeMacros)) this.macros.set(intern(name), macro);
    installPrimitives(this);
    installControl(this);
    installEopl(this);
    for (const alias of ['system-global-environment', 'user-initial-environment']) this.defineGlobal(alias, this.globalEnv);
    this.defineGlobal('true', true);
    this.defineGlobal('false', false);
    this.defineGlobal('the-environment-object', this.globalEnv);

    if (opts.prelude) this.runLibrarySource(opts.prelude);
    this.seal();
    for (const [name, src] of Object.entries(opts.libraries || {})) this.libraries.set(name, src);
  }

  // --- global variables ----------------------------------------------------------------
  globalBox(sym) {
    sym = stripSym(sym);
    const table = this.systemMode ? this.sysGlobals : this.userGlobals;
    let b = table.get(sym);
    if (!b) { b = new Box(sym.name, UNBOUND); table.set(sym, b); }
    return b;
  }
  defineGlobal(name, value) { this.globalBox(intern(name)).v = value; }

  definePrimitive(p) {
    this.primTable.set(p.name, p);
    this.defineGlobal(p.name, p);
  }
  aliasPrimitive(newName, oldName) {
    const p = this.primTable.get(oldName);
    if (!p) throw new Error('internal: alias of unknown primitive ' + oldName);
    this.primTable.set(newName, p);
    this.defineGlobal(newName, p);
  }

  // After the prelude is loaded, user code gets its own copy of the global
  // table: redefining car/cons/map/... can't change what library procedures do.
  seal() {
    this.userGlobals = new Map();
    this.syncToUser(true);
    this.systemMode = false;
  }
  syncToUser(all) {
    for (const [sym, box] of this.sysGlobals) {
      const ub = this.userGlobals.get(sym);
      if (!ub) this.userGlobals.set(sym, new Box(box.name, box.v));
      else if (all || box.v !== UNBOUND) ub.v = box.v;
    }
  }

  // --- libraries ('#lang name' / (require-library ...)) -----------------------------------------
  hasLibrary(name) { return BUILTIN_LANGS.has(name) || this.libraries.has(name); }
  registerLibrary(name, source) { this.libraries.set(name, source); }
  availableLibraries() { return [...BUILTIN_LANGS, ...this.libraries.keys()]; }

  loadLibrary(name) {
    if (BUILTIN_LANGS.has(name) || this.loadedLibraries.has(name)) return;
    const src = this.libraries.get(name);
    if (src === undefined) throw new Error('unknown library ' + name);
    this.loadedLibraries.add(name);
    const system = !USER_MODE_LIBRARIES.has(name);
    if (system) {
      // A library compiled now would pick up the other one's macros (its `if`), not the real ones.
      const changed = [...this.loadedLibraries].find((n) => USER_MODE_LIBRARIES.has(n));
      if (changed) {
        this.loadedLibraries.delete(name);
        throw new Error('cannot load "' + name + '" after "' + changed + '": ' + changed +
          ' has changed if, car, cdr, + and < for this page. Press Reset first.');
      }
    }
    this.runLibrarySource(src, system);
    if (system) this.syncToUser(false); // a user-mode library's definitions are already in the user table
  }

  // Evaluate source in system mode (globals go to the system table) or, for a library that
  // changes the meaning of core names, in user mode (globals go to the user table).
  runLibrarySource(source, system = true) {
    const wasSystem = this.systemMode;
    this.systemMode = system;
    try {
      const job = new Job(this, source, { library: true });
      const r = job.runToCompletion();
      if (r.state === 'error') {
        const msg = r.segments.filter((s) => s.kind === 'error').map((s) => s.text).join('; ');
        throw new Error('library failed to load: ' + msg);
      }
    } finally { this.systemMode = wasSystem; }
  }

  // --- output ------------------------------------------------------------------------------------
  portWrite(port, text) {
    if (text === '') return;
    const nl = text.lastIndexOf('\n');
    port.col = nl < 0 ? port.col + text.length : text.length - nl - 1;
    if (port.kind === 'console-out') { if (this.sink) this.sink(text); } else port.buf += text;
  }

  // --- running code ------------------------------------------------------------------------------------
  // Each run starts with an empty console input: an "end of input" given to one cell must not
  // make every later cell's read return end-of-file at once.
  startRun(source) { this.consoleIn = new Port('console-in'); this.runCount++; return new Job(this, source, {}); }
  evalSync(source) { return this.startRun(source).runToCompletion(); }
}

export class Job {
  constructor(interp, source, opts) {
    this.interp = interp;
    this.library = !!opts.library;
    this.segments = [];
    this.sinceDrain = 0;       // segments already handed to the host
    this.out = '';
    this.outTotal = 0;
    this.truncated = false;
    this.state = 'running';    // running | input | done | error | stopped | exit
    this.cancelled = false;
    this.running = false;      // a top-level form is mid-evaluation
    this.langDone = false;
    this.exitCode = null;
    try {
      this.parser = new Parser(source);
    } catch (e) { this.parser = null; this._fail(e); }
  }

  interrupt() { this.cancelled = true; }

  provideInput(text) {
    if (this.state !== 'input') return;
    this.state = 'running';
    this.interp.machine.resume(text);
  }

  // Newly produced segments since the last call.
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
  _push(kind, text) { this._flush(); this.segments.push({ kind, text }); }
  _fail(e) {
    if (e instanceof SchemeThrow) this._push('error', uncaughtReport(e.payload));
    else this._push('error', 'Internal error: ' + (e && e.message ? e.message : String(e)));
    this.state = 'error';
  }
  _finish(state) { this._flush(); if (this.truncated) this.segments.push({ kind: 'status', text: '(output truncated)' }); this.state = state; }

  _sink(text) {
    if (this.truncated) return;
    this.outTotal += text.length;
    if (this.outTotal > MAX_OUTPUT_CHARS) { this.truncated = true; return; }
    this.out += text;
  }

  // Run for roughly `budgetMs`; returns {state, segments} (segments = new ones).
  step(budgetMs = 25) {
    const interp = this.interp, machine = interp.machine;
    if (this.state === 'input' && this.cancelled) this.state = 'running'; // Stop while waiting for input
    if (this.state === 'running') {
      interp.sink = (t) => this._sink(t);
      const deadline = performance.now() + budgetMs;
      try {
        this._loop(deadline);
      } catch (e) {
        machine.abandon();
        if (e instanceof SchemeAbort) { this._push('error', e.message); this._finish('error'); }
        else if (e instanceof SchemeExit) { this.exitCode = e.code; this._finish('exit'); }
        else if (e instanceof SchemeThrow) { this._fail(e); this._finish('error'); }
        else { this._fail(e); this._finish('error'); }
      } finally {
        interp.sink = null;
        interp.currentOut = interp.consoleOut;
      }
    }
    return { state: this.state, segments: this.drain() };
  }

  _loop(deadline) {
    const interp = this.interp, machine = interp.machine;
    if (!this.langDone) {
      this.langDone = true;
      interp.consoleOut.col = 0; // each run's output starts on a fresh line (matters for fresh-line)
      const lang = this.parser && this.parser.lang;
      if (lang && !this.library) {
        if (!interp.hasLibrary(lang)) {
          this._push('error', 'Unknown #lang "' + lang + '". Available: ' + interp.availableLibraries().join(', '));
          this._finish('error');
          return;
        }
        interp.loadLibrary(lang);
      }
    }
    for (;;) {
      if (this.cancelled) { machine.abandon(); this._push('status', 'Stopped'); this._finish('stopped'); return; }
      if (!this.running) {
        let datum;
        try { datum = this.parser.next(); } catch (e) { this._fail(e); this._finish('error'); return; }
        if (datum === EOF) { this._finish('done'); return; }
        let node;
        try { node = interp.compiler.analyze(datum, null); } catch (e) {
          if (e instanceof SchemeThrow) { this._fail(e); this._finish('error'); return; }
          throw e;
        }
        interp.currentOut = interp.consoleOut;
        machine.begin(node);
        this.running = true;
      }
      const status = machine.run(deadline);
      if (status === STATUS.YIELD) return;
      if (status === STATUS.INPUT) { this._flush(); this.state = 'input'; return; }
      if (status === STATUS.ERROR) {
        machine.abandon();
        this._push('error', uncaughtReport(machine.uncaught));
        this._finish('error');
        return;
      }
      // DONE
      this.running = false;
      const v = machine.val;
      if (!this.library && v !== UNSPEC && !(v instanceof Values && v.vals.length === 0)) this._push('value', toWrite(v));
    }
  }

  // Synchronous convenience for tests and library loading.
  runToCompletion() {
    for (let guard = 0; guard < 1e6; guard++) {
      const r = this.step(1000);
      if (r.state === 'input') { this.provideInput(null); continue; } // no input available: EOF
      if (r.state !== 'running') return { state: r.state, segments: this.segments, exitCode: this.exitCode };
    }
    throw new Error('runToCompletion: did not finish');
  }
}

// Text of a run, for assertions: stdout and values as a REPL would show them.
export function transcript(result) {
  return result.segments.map((s) => (s.kind === 'error' ? ';' + s.text : s.text)).join('\n');
}
