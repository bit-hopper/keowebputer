// Arithmetic, comparison and logic primitives (LOGO.md 4.2; manual, ARITHMETIC; 11.5 item 2 for the checked behaviour).
// Numbers are JS doubles. Printing is numbers.js's job, not this file's.

import { isList, equalp, listFromArray } from './data.js';
import { err } from './errors.js';
import { showForm } from './printer.js';
import { num, int, tf, bool } from './prims.js';
import { CBFrame, PENDING, VALUE, tfOf } from './machine.js';

// printf("%.*f") for the FORM primitive. JS toFixed rounds a binary tie (2.5 to 0 places) away from zero where C rounds
// it to even, and the reference prints through C, so ties are settled here. Anything that is not an exact tie is toFixed.
function formatFixed(x, digits) {
  const scale = Math.pow(10, digits);
  const scaled = Math.abs(x) * scale;
  if (Number.isFinite(scaled) && scaled < 1e15 && scaled - Math.floor(scaled) === 0.5) {
    const lower = Math.floor(scaled);
    const even = lower % 2 === 0 ? lower : lower + 1;
    const s = (even / scale).toFixed(digits);
    return (x < 0 && even !== 0 ? '-' : '') + s;
  }
  return x.toFixed(digits);
}

// A small seedable generator so RERANDOM makes RANDOM reproducible (manual). mulberry32.
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RAD = Math.PI / 180;

export function install(P) {
  const sum = (a) => { let s = 0; for (const x of a) s += num(x, 'sum'); return s; };
  P.fn('sum', 2, sum, { min: 0, max: -1 });
  P.fn('+', 2, (a) => num(a[0], '+') + num(a[1], '+'));
  P.fn('difference', 2, (a) => num(a[0], 'difference') - num(a[1], 'difference'));
  P.fn('-', 2, (a) => num(a[0], '-') - num(a[1], '-'));
  // The hidden tight-binding subtraction runparse makes for a monadic minus (plm 3.6b).
  P.fn('--', 2, (a) => num(a[0], '-') - num(a[1], '-'));
  P.fn('minus', 1, (a) => { const v = -num(a[0], 'minus'); return v === 0 ? 0 : v; });
  P.fn('product', 2, (a) => { let s = 1; for (const x of a) s *= num(x, 'product'); return s; }, { min: 0, max: -1 });
  P.fn('*', 2, (a) => num(a[0], '*') * num(a[1], '*'));
  const quotient = (name) => (a) => {
    if (a.length === 1) { const d = num(a[0], name); if (d === 0) throw err.badValue(name, '0'); return 1 / d; }
    const d = num(a[1], name);
    if (d === 0) throw err.badValue(name, '0');
    return num(a[0], name) / d;
  };
  P.fn('quotient', 2, quotient('quotient'), { min: 1, max: 2 });
  P.fn('/', 2, quotient('/'));
  P.fn('remainder', 2, (a) => {
    const x = int(a[0], 'remainder'), y = int(a[1], 'remainder');
    if (y === 0) throw err.badValue('remainder', '0');
    const r = x % y;
    return r === 0 ? 0 : r;
  });
  P.fn('modulo', 2, (a) => {
    const x = int(a[0], 'modulo'), y = int(a[1], 'modulo');
    if (y === 0) throw err.badValue('modulo', '0');
    const r = ((x % y) + y) % y;
    return r === 0 ? 0 : r;
  });
  P.fn('int', 1, (a) => { const v = Math.trunc(num(a[0], 'int')); return v === 0 ? 0 : v; });
  // Half away from zero (Math.round rounds -2.5 to -2).
  P.fn('round', 1, (a) => { const v = num(a[0], 'round'); const r = Math.sign(v) * Math.round(Math.abs(v)); return r === 0 ? 0 : r; });
  P.fn('sqrt', 1, (a) => Math.sqrt(num(a[0], 'sqrt')));
  P.fn('power', 2, (a) => Math.pow(num(a[0], 'power'), num(a[1], 'power')));
  P.fn('exp', 1, (a) => Math.exp(num(a[0], 'exp')));
  P.fn('log10', 1, (a) => Math.log10(num(a[0], 'log10')));
  P.fn('ln', 1, (a) => Math.log(num(a[0], 'ln')));
  P.fn('sin', 1, (a) => Math.sin(num(a[0], 'sin') * RAD));
  P.fn('cos', 1, (a) => Math.cos(num(a[0], 'cos') * RAD));
  P.fn('radsin', 1, (a) => Math.sin(num(a[0], 'radsin')));
  P.fn('radcos', 1, (a) => Math.cos(num(a[0], 'radcos')));
  P.fn('arctan', 1, (a) => (a.length === 1
    ? Math.atan(num(a[0], 'arctan')) / RAD
    : Math.atan2(num(a[1], 'arctan'), num(a[0], 'arctan')) / RAD), { min: 1, max: 2 });
  P.fn('radarctan', 1, (a) => (a.length === 1
    ? Math.atan(num(a[0], 'radarctan'))
    : Math.atan2(num(a[1], 'radarctan'), num(a[0], 'radarctan'))), { min: 1, max: 2 });

  P.fn('iseq', 2, (a) => {
    const from = int(a[0], 'iseq'), to = int(a[1], 'iseq');
    const out = [];
    if (from <= to) for (let i = from; i <= to; i++) out.push(i);
    else for (let i = from; i >= to; i--) out.push(i);
    return listFromArray(out);
  });
  P.fn('rseq', 3, (a) => {
    const from = num(a[0], 'rseq'), to = num(a[1], 'rseq'), count = int(a[2], 'rseq');
    if (count < 1) throw err.badValue('rseq', showForm(a[2]));
    if (count === 1) return listFromArray([from]);
    const out = [];
    for (let i = 0; i < count; i++) out.push(from + (to - from) * i / (count - 1));
    return listFromArray(out);
  });

  // ---- comparison ----------------------------------------------------------------------------------------------
  const cmp = (name, f) => (a) => bool(f(num(a[0], name), num(a[1], name)));
  P.fn('lessp less?', 2, cmp('lessp', (x, y) => x < y));
  P.fn('<', 2, cmp('<', (x, y) => x < y));
  P.fn('greaterp greater?', 2, cmp('greaterp', (x, y) => x > y));
  P.fn('>', 2, cmp('>', (x, y) => x > y));
  P.fn('lessequalp lessequal?', 2, cmp('lessequalp', (x, y) => x <= y));
  P.fn('<=', 2, cmp('<=', (x, y) => x <= y));
  P.fn('greaterequalp greaterequal?', 2, cmp('greaterequalp', (x, y) => x >= y));
  P.fn('>=', 2, cmp('>=', (x, y) => x >= y));
  P.fn('equalp equal?', 2, (a) => bool(equalp(a[0], a[1])));
  P.fn('=', 2, (a) => bool(equalp(a[0], a[1])));
  P.fn('notequalp notequal?', 2, (a) => bool(!equalp(a[0], a[1])));
  P.fn('<>', 2, (a) => bool(!equalp(a[0], a[1])));

  // ---- random --------------------------------------------------------------------------------------------------
  P.fn('random', 1, (a, m) => {
    const rng = m.interp.rng;
    if (a.length === 1) {
      const n = int(a[0], 'random');
      if (n < 1) throw err.badValue('random', showForm(a[0]));
      return Math.floor(rng() * n);
    }
    const lo = int(a[0], 'random'), hi = int(a[1], 'random');
    if (hi < lo) throw err.badValue('random', showForm(a[1]));
    return lo + Math.floor(rng() * (hi - lo + 1));
  }, { min: 1, max: 2 });
  P.fn('rerandom', 0, (a, m) => {
    m.interp.rng = makeRng(a.length ? int(a[0], 'rerandom') : 1);
  }, { min: 0, max: 1 });

  // ---- print formatting -------------------------------------------------------------------------------------------
  P.fn('form', 3, (a) => {
    const x = num(a[0], 'form'), width = int(a[1], 'form'), prec = int(a[2], 'form');
    if (width < 0) throw err.badValue('form', showForm(a[1]));
    const s = formatFixed(x, prec);
    return s.length >= width ? s : ' '.repeat(width - s.length) + s;
  });

  // ---- bitwise (64-bit two's complement, as the reference's long) --------------------------------------------------
  const big = (x, who) => BigInt(int(x, who));
  const back = (b) => Number(BigInt.asIntN(64, b));
  P.fn('bitand', 2, (a) => back(a.reduce((acc, x) => acc & big(x, 'bitand'), -1n)), { min: 0, max: -1 });
  P.fn('bitor', 2, (a) => back(a.reduce((acc, x) => acc | big(x, 'bitor'), 0n)), { min: 0, max: -1 });
  P.fn('bitxor', 2, (a) => back(a.reduce((acc, x) => acc ^ big(x, 'bitxor'), 0n)), { min: 0, max: -1 });
  P.fn('bitnot', 1, (a) => back(~big(a[0], 'bitnot')));
  P.fn('ashift', 2, (a) => {
    const x = big(a[0], 'ashift'), s = Number(big(a[1], 'ashift'));
    return back(s >= 0 ? x << BigInt(s) : x >> BigInt(-s));
  });
  P.fn('lshift', 2, (a) => {
    const x = big(a[0], 'lshift'), s = Number(big(a[1], 'lshift'));
    if (s >= 0) return back(x << BigInt(s));
    return back(BigInt.asUintN(64, x) >> BigInt(-s));
  });

  // ---- logic ---------------------------------------------------------------------------------------------------
  // AND / OR / NOT take TRUE / FALSE words, or a list to run as an expression (manual, LOGICAL OPERATIONS). A list is
  // evaluated left to right and the rest are skipped once the answer is settled, which is why these are machine ops.
  const logic = (name, stopOn) => (m, args, want, blame) => {
    const step = (i) => {
      if (i >= args.length) { m.complete(bool(!stopOn), want, blame, name); return; }
      const x = args[i];
      if (isList(x)) {
        m.stack.push(new CBFrame((mm, v) => {
          if (tfOf(v, name) === stopOn) mm.complete(bool(stopOn), want, blame, name); else step(i + 1);
        }));
        m.runList(x, VALUE, name, null, name);
        return;
      }
      if (tf(x, name) === stopOn) { m.complete(bool(stopOn), want, blame, name); return; }
      step(i + 1);
    };
    step(0);
    return PENDING;
  };
  P.op('and', 2, logic('and', false), { min: 0, max: -1 });
  P.op('or', 2, logic('or', true), { min: 0, max: -1 });
  P.op('not', 1, (m, args, want, blame) => {
    const x = args[0];
    if (isList(x)) {
      m.stack.push(new CBFrame((mm, v) => mm.complete(bool(!tfOf(v, 'not')), want, blame, 'not')));
      m.runList(x, VALUE, 'not', null, 'not');
      return PENDING;
    }
    return bool(!tf(x, 'not'));
  });
}
