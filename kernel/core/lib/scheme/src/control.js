// Primitives that need the machine (continuations, dynamic extent, apply, force,
// eval) plus port I/O (which may pause the machine to wait for input).
import {
  UNSPEC, UNASSIGNED, EOF, SString, Char, Primitive, MPrim, Promise_, Values, Port, Parameter,
  Continuation, SchemeExit, Environment, LexicalEnv, makeChar, listToArray,
} from './types.js';
import { frameScope } from './compiler.js';
import { Frame, Winder, HandlerEntry, F_JS } from './machine.js';
import { wrongType } from './errors.js';
import { toDisplay, toWrite } from './printer.js';
import { Parser } from './reader.js';

const RET = 1, EVAL = 0;

export function installControl(interp) {
  const defM = (name, min, max, fn) => interp.definePrimitive(new MPrim(name, min, max, fn));
  const def = (name, min, max, fn) => interp.definePrimitive(new Primitive(name, min, max, fn));
  const alias = (a, b) => interp.aliasPrimitive(a, b);

  defM('apply', 1, -1, (m, vals) => {
    const f = vals[1];
    if (vals.length === 2) { m.applyProc([f]); return; }
    const last = vals[vals.length - 1];
    const tail = listToArray(last);
    if (tail === null) throw wrongType(last, vals.length - 1, 'apply');
    m.applyProc([f, ...vals.slice(2, -1), ...tail]);
  });

  defM('call-with-current-continuation', 1, 1, (m, vals) => {
    m.applyProc([vals[1], new Continuation(m.k, m.winders, m.handlers)]);
  });
  alias('call/cc', 'call-with-current-continuation');
  alias('call-with-escape-continuation', 'call-with-current-continuation');
  alias('within-continuation', 'call-with-current-continuation');

  def('values', 0, -1, (...a) => (a.length === 1 ? a[0] : new Values(a)));
  defM('call-with-values', 2, 2, (m, vals) => {
    m.k = new Frame(F_JS, m.k, (m2, val, consumer) => {
      m2.applyProc([consumer, ...(val instanceof Values ? val.vals : [val])]);
    }, vals[2]);
    m.applyProc([vals[1]]);
  });

  defM('dynamic-wind', 3, 3, (m, vals) => {
    const before = vals[1], thunk = vals[2], after = vals[3];
    m.k = new Frame(F_JS, m.k, (m2) => {
      const w = new Winder(before, after, m2.winders);
      m2.winders = w;
      m2.k = new Frame(F_JS, m2.k, (m3, val) => {
        m3.winders = w.next;
        m3.k = new Frame(F_JS, m3.k, (m4, _v, saved) => { m4.val = saved; }, val);
        m3.applyProc([after]);
      }, null);
      m2.applyProc([thunk]);
    }, null);
    m.applyProc([before]);
  });

  defM('with-exception-handler', 2, 2, (m, vals) => {
    const handler = vals[1], thunk = vals[2];
    m.k = new Frame(F_JS, m.k, (m2, _v, old) => { m2.handlers = old; }, m.handlers);
    m.handlers = new HandlerEntry(handler, m.handlers);
    m.applyProc([thunk]);
  });
  defM('raise', 1, 1, (m, vals) => { m.doRaise(vals[1], false); });
  defM('raise-continuable', 1, 1, (m, vals) => { m.doRaise(vals[1], true); });

  defM('force', 1, 1, (m, vals) => {
    const p = vals[1];
    if (!(p instanceof Promise_)) { m.val = p; m.mode = RET; return; }
    if (p.done) { m.val = p.value; m.mode = RET; return; }
    m.k = new Frame(F_JS, m.k, (m2, val, pr) => {
      if (!pr.done) { pr.done = true; pr.value = val; pr.node = null; pr.env = null; }
      m2.val = pr.value;
    }, p);
    m.node = p.node; m.env = p.env; m.mode = EVAL;
  });

  defM('eval', 1, 2, (m, vals) => {
    const e = vals[2];
    if (e instanceof LexicalEnv) {
      // Analyze against the captured scope and run in the captured frame. A `define`
      // in the evaluated code adds a name to the shared scope; this frame grows to match.
      m.node = interp.compiler.analyze(vals[1], e.scope);
      const names = frameScope(e.scope).names;
      while (e.frame.length < names.length + 1) e.frame.push(UNASSIGNED);
      m.env = e.frame; m.mode = EVAL;
      return;
    }
    if (e !== undefined && !(e instanceof Environment)) throw wrongType(e, 2, 'eval');
    m.node = interp.compiler.analyze(vals[1], null);
    m.env = null; m.mode = EVAL;
  });
  def('exit', 0, 1, (code) => { throw new SchemeExit(code === undefined ? 0 : code); });
  alias('%exit', 'exit'); alias('emergency-exit', 'exit');

  // parameters (make-parameter / parameterize via dynamic-wind in the prelude)
  def('make-parameter', 1, 2, (v) => new Parameter(v, null));
  def('%parameter-value', 1, 1, (p) => p.value);
  def('%parameter-set!', 2, 2, (p, v) => { p.value = v; return UNSPEC; });

  // --- ports ---------------------------------------------------------------------------
  const outPort = (p, i, who) => {
    if (p === undefined) return interp.currentOut;
    if (!(p instanceof Port) || (p.kind !== 'out-string' && p.kind !== 'console-out')) throw wrongType(p, i, who);
    return p;
  };
  const portWrite = (p, text) => interp.portWrite(p, text);

  def('display', 1, 3, (x, p) => { portWrite(outPort(p, 2, 'display'), toDisplay(x)); return UNSPEC; });
  def('write', 1, 3, (x, p) => { portWrite(outPort(p, 2, 'write'), toWrite(x)); return UNSPEC; });
  alias('write-shared', 'write'); alias('write-simple', 'write');
  def('write-string', 1, 4, (s, p) => { if (!(s instanceof SString)) throw wrongType(s, 1, 'write-string'); portWrite(outPort(p, 2, 'write-string'), s.s); return UNSPEC; });
  def('write-char', 1, 2, (c, p) => { if (!(c instanceof Char)) throw wrongType(c, 1, 'write-char'); portWrite(outPort(p, 2, 'write-char'), String.fromCodePoint(c.cp)); return UNSPEC; });
  def('newline', 0, 1, (p) => { portWrite(outPort(p, 1, 'newline'), '\n'); return UNSPEC; });
  def('fresh-line', 0, 1, (p) => { const port = outPort(p, 1, 'fresh-line'); if (port.col !== 0) portWrite(port, '\n'); return UNSPEC; });
  def('write-line', 1, 2, (x, p) => { const port = outPort(p, 2, 'write-line'); portWrite(port, toWrite(x) + '\n'); return UNSPEC; });
  def('pp', 1, 3, (x, p) => { portWrite(outPort(p, 2, 'pp'), toWrite(x) + '\n'); return UNSPEC; });
  def('flush-output', 0, 1, () => UNSPEC);
  def('current-output-port', 0, 0, () => interp.currentOut);
  def('current-error-port', 0, 0, () => interp.currentOut);
  def('current-input-port', 0, 0, () => interp.consoleIn);
  def('open-output-string', 0, 0, () => new Port('out-string'));
  def('open-input-string', 1, 1, (s) => {
    if (!(s instanceof SString)) throw wrongType(s, 1, 'open-input-string');
    const p = new Port('in-string'); p.input = s.s; p.eof = true; return p;
  });
  def('get-output-string', 1, 1, (p) => {
    if (!(p instanceof Port) || p.kind !== 'out-string') throw wrongType(p, 1, 'get-output-string');
    return new SString(p.buf);
  });
  def('port?', 1, 1, (x) => x instanceof Port);
  def('close-port', 1, 1, () => UNSPEC); alias('close-input-port', 'close-port'); alias('close-output-port', 'close-port');

  // with-output-to-string is in the prelude (dynamic-wind + this setter), so an
  // escape out of the thunk restores the console port.
  def('%set-current-output!', 1, 1, (p) => { const old = interp.currentOut; interp.currentOut = p; return old; });
  defM('call-with-output-string', 1, 1, (m, vals) => {
    const port = new Port('out-string');
    m.k = new Frame(F_JS, m.k, (m2) => { m2.val = new SString(port.buf); }, null);
    m.applyProc([vals[1], port]);
  });

  // Input. `op(port)` returns a value, or undefined if the console port needs
  // more text from the host (the machine then pauses until Job.provideInput).
  function consoleRead(m, port, op) {
    const v = op(port);
    if (v !== undefined) { m.val = v; m.mode = RET; return; }
    m.pause = 'input';
    m.inputResolver = (m2, text) => {
      if (text === null) port.eof = true; else port.input += text + '\n';
      consoleRead(m2, port, op);
    };
  }
  const inPort = (p, i, who) => {
    if (p === undefined) return interp.consoleIn;
    if (!(p instanceof Port) || (p.kind !== 'in-string' && p.kind !== 'console-in')) throw wrongType(p, i, who);
    return p;
  };
  defM('read-line', 0, 1, (m, vals) => consoleRead(m, inPort(vals[1], 1, 'read-line'), (p) => {
    if (p.pos >= p.input.length) return p.eof ? EOF : undefined;
    const nl = p.input.indexOf('\n', p.pos);
    if (nl < 0) { if (!p.eof) return undefined; const s = p.input.slice(p.pos); p.pos = p.input.length; return new SString(s); }
    const s = p.input.slice(p.pos, nl);
    p.pos = nl + 1;
    return new SString(s.replace(/\r$/, ''));
  }));
  defM('read-char', 0, 1, (m, vals) => consoleRead(m, inPort(vals[1], 1, 'read-char'), (p) => {
    if (p.pos >= p.input.length) return p.eof ? EOF : undefined;
    const cp = p.input.codePointAt(p.pos);
    p.pos += cp > 0xffff ? 2 : 1;
    return makeChar(cp);
  }));
  defM('peek-char', 0, 1, (m, vals) => consoleRead(m, inPort(vals[1], 1, 'peek-char'), (p) => {
    if (p.pos >= p.input.length) return p.eof ? EOF : undefined;
    return makeChar(p.input.codePointAt(p.pos));
  }));
  defM('read-string', 1, 2, (m, vals) => {
    let k = vals[1], port = vals[2];
    if (k instanceof Port) { const t = k; k = port; port = t; } // alternate (port, count) argument order
    if (typeof k !== 'number' || k < 0) throw wrongType(k, 1, 'read-string');
    consoleRead(m, inPort(port, 2, 'read-string'), (p) => {
      const chars = [...p.input.slice(p.pos)];
      if (chars.length === 0) return p.eof ? EOF : undefined;
      if (chars.length < k && !p.eof) return undefined;
      const s = chars.slice(0, k).join('');
      p.pos += s.length;
      return new SString(s);
    });
  });
  defM('read', 0, 1, (m, vals) => consoleRead(m, inPort(vals[1], 1, 'read'), (p) => {
    const rest = p.input.slice(p.pos);
    if (rest.trim() === '') return p.eof ? EOF : undefined;
    const parser = new Parser(rest);
    try {
      const d = parser.next();
      p.pos += parser.i;
      return d;
    } catch (e) {
      const incomplete = e && e.payload && e.payload.kind === 'parse-error' && /end of input|Unterminated/.test(e.payload.message);
      if (incomplete && !p.eof) return undefined;
      p.pos = p.input.length;
      throw e;
    }
  }));
  def('char-ready?', 0, 1, () => true);
}
