// Words, lists and arrays: constructors, selectors, mutators, predicates and queries (LOGO.md 4.2; manual, DATA STRUCTURE
// PRIMITIVES; 11.5 items 4-5 for the behaviour checked against the reference). Data representation is data.js: a word is a
// JS string (or number), a list is cons cells ending in NIL, an array is an LArray.

import {
  Cell, NIL, LArray, QWord, isList, isWord, wordText, numberValue, listFromArray, listToArray, listLength, equalp, nameKey,
} from './data.js';
import { err } from './errors.js';
import { showForm } from './printer.js';
import { runparse } from './runparse.js';
import { parseText } from './reader.js';
import { num, int, wordArg, listArg, arrayArg, bool } from './prims.js';

// The characters of a word argument as a JS array of one-character strings.
const chars = (text) => Array.from(text);

export function install(P) {
  // ---- constructors ------------------------------------------------------------------------------------------------
  P.fn('word', 2, (a) => {
    let s = '';
    for (const x of a) s += wordArg(x, 'word');
    return s;
  }, { min: 0, max: -1 });

  P.fn('list', 2, (a) => listFromArray(a), { min: 0, max: -1 });

  P.fn('sentence se', 2, (a) => {
    const out = [];
    for (const x of a) {
      if (isList(x)) for (let c = x; c instanceof Cell; c = c.rest) out.push(c.first);
      else out.push(x);
    }
    return listFromArray(out);
  }, { min: 0, max: -1 });

  P.fn('fput', 2, (a) => {
    const thing = a[0], l = a[1];
    if (isList(l)) return new Cell(thing, l);
    if (isWord(l)) {
      const t = wordText(thing);
      if (!isWord(thing) || chars(t).length !== 1) throw err.badType('fput', showForm(thing));
      return t + wordText(l);
    }
    throw err.badType('fput', showForm(l));
  });

  P.fn('lput', 2, (a) => {
    const thing = a[0], l = a[1];
    if (isList(l)) { const items = listToArray(l); items.push(thing); return listFromArray(items); }
    if (isWord(l)) {
      const t = wordText(thing);
      if (!isWord(thing) || chars(t).length !== 1) throw err.badType('lput', showForm(thing));
      return wordText(l) + t;
    }
    throw err.badType('lput', showForm(l));
  });

  P.fn('array', 1, (a) => {
    const size = int(a[0], 'array');
    if (size < 0) throw err.badValue('array', showForm(a[0]));
    const origin = a.length > 1 ? int(a[1], 'array') : 1;
    return new LArray(new Array(size).fill(NIL), origin);
  }, { min: 1, max: 2 });

  P.fn('listtoarray', 1, (a) => new LArray(listToArray(listArg(a[0], 'listtoarray')), a.length > 1 ? int(a[1], 'listtoarray') : 1),
    { min: 1, max: 2 });
  P.fn('arraytolist', 1, (a) => listFromArray(arrayArg(a[0], 'arraytolist').items));

  P.fn('combine', 2, (a) => {
    if (isList(a[1])) return new Cell(a[0], a[1]);
    return wordArg(a[0], 'combine') + wordArg(a[1], 'combine');
  });

  P.fn('reverse', 1, (a) => {
    const x = a[0];
    if (isList(x)) { let out = NIL; for (let c = x; c instanceof Cell; c = c.rest) out = new Cell(c.first, out); return out; }
    return chars(wordArg(x, 'reverse')).reverse().join('');
  });

  P.fn('gensym', 0, (a, m) => 'g' + (++m.interp.gensymCount));

  // ---- selectors ---------------------------------------------------------------------------------------------------
  P.fn('first', 1, (a) => {
    const x = a[0];
    if (x instanceof Cell) return x.first;
    if (x instanceof LArray) return x.origin;
    if (isWord(x)) {
      const t = wordText(x);
      if (t === '') throw err.badType('first', showForm(x));
      return Array.from(t)[0];
    }
    throw err.badType('first', showForm(x));
  });

  P.fn('last', 1, (a) => {
    const x = a[0];
    if (x instanceof Cell) { let c = x; while (c.rest instanceof Cell) c = c.rest; return c.first; }
    if (isWord(x)) {
      const t = wordText(x);
      if (t === '') throw err.badType('last', showForm(x));
      const cs = chars(t);
      return cs[cs.length - 1];
    }
    throw err.badType('last', showForm(x));
  });

  P.fn('butfirst bf', 1, (a) => {
    const x = a[0];
    if (x instanceof Cell) return x.rest;
    if (isWord(x)) {
      const t = wordText(x);
      if (t === '') throw err.badType('butfirst', showForm(x));
      return chars(t).slice(1).join('');
    }
    throw err.badType('butfirst', showForm(x));
  });

  P.fn('butlast bl', 1, (a) => {
    const x = a[0];
    if (x instanceof Cell) { const items = listToArray(x); items.pop(); return listFromArray(items); }
    if (isWord(x)) {
      const t = wordText(x);
      if (t === '') throw err.badType('butlast', showForm(x));
      return chars(t).slice(0, -1).join('');
    }
    throw err.badType('butlast', showForm(x));
  });

  P.fn('firsts', 1, (a) => listFromArray(listToArray(listArg(a[0], 'firsts')).map((x) => {
    if (x instanceof Cell) return x.first;
    if (isWord(x) && wordText(x) !== '') return chars(wordText(x))[0];
    throw err.badType('firsts', showForm(x));
  })));

  P.fn('butfirsts bfs', 1, (a) => listFromArray(listToArray(listArg(a[0], 'butfirsts')).map((x) => {
    if (x instanceof Cell) return x.rest;
    if (isWord(x) && wordText(x) !== '') return chars(wordText(x)).slice(1).join('');
    throw err.badType('butfirsts', showForm(x));
  })));

  P.fn('item', 2, (a) => {
    const idx = int(a[0], 'item'), x = a[1];
    if (x instanceof Cell) {
      if (idx < 1) throw err.badValue('item', showForm(a[0]));
      let c = x;
      for (let k = 1; k < idx && c instanceof Cell; k++) c = c.rest;
      if (!(c instanceof Cell)) throw err.badValue('item', showForm(a[0]));
      return c.first;
    }
    if (x instanceof LArray) {
      const k = idx - x.origin;
      if (k < 0 || k >= x.items.length) throw err.badValue('item', showForm(a[0]));
      return x.items[k];
    }
    if (isWord(x)) {
      const cs = chars(wordText(x));
      if (idx < 1 || idx > cs.length) throw err.badValue('item', showForm(a[0]));
      return cs[idx - 1];
    }
    throw err.badType('item', showForm(x));
  });

  P.fn('pick', 1, (a, m) => {
    const items = listToArray(listArg(a[0], 'pick'));
    if (items.length === 0) throw err.badType('pick', '[]');
    return items[Math.floor(m.interp.rng() * items.length)];
  });

  P.fn('remove', 2, (a) => {
    const thing = a[0], l = a[1];
    if (isList(l)) return listFromArray(listToArray(l).filter((x) => !equalp(x, thing)));
    return chars(wordArg(l, 'remove')).filter((c) => !equalp(c, thing)).join('');
  });

  P.fn('remdup', 1, (a) => {
    const items = listToArray(listArg(a[0], 'remdup'));
    const out = [];
    // The rightmost of equal members remains (manual).
    for (let i = 0; i < items.length; i++) {
      let later = false;
      for (let j = i + 1; j < items.length; j++) if (equalp(items[i], items[j])) { later = true; break; }
      if (!later) out.push(items[i]);
    }
    return listFromArray(out);
  });

  P.fn('quoted', 1, (a) => (isList(a[0]) ? a[0] : '"' + wordText(a[0])));

  // ---- mutators ----------------------------------------------------------------------------------------------------
  const setitem = (name) => (a) => {
    const idx = int(a[0], name), arr = arrayArg(a[1], name);
    const k = idx - arr.origin;
    if (k < 0 || k >= arr.items.length) throw err.badValue(name, showForm(a[0]));
    arr.items[k] = a[2];
  };
  P.fn('setitem', 3, setitem('setitem'));
  P.fn('.setitem', 3, setitem('.setitem'));
  P.fn('.setfirst', 2, (a) => {
    if (!(a[0] instanceof Cell)) throw err.badType('.setfirst', showForm(a[0]));
    a[0].first = a[1];
  });
  P.fn('.setbf', 2, (a) => {
    if (!(a[0] instanceof Cell)) throw err.badType('.setbf', showForm(a[0]));
    if (!isList(a[1])) throw err.badType('.setbf', showForm(a[1]));
    a[0].rest = a[1];
  });

  // PUSH / POP / QUEUE / DEQUEUE act on a variable holding a list, by name.
  const stackVar = (a, who, m) => {
    const key = nameKey(wordArg(a[0], who));
    const v = m.lookupVar(key, wordText(a[0]));
    if (!isList(v)) throw err.badType(who, showForm(v));
    return [key, v];
  };
  P.fn('push', 2, (a, m) => { const [key, v] = stackVar(a, 'push', m); m.setVar(key, new Cell(a[1], v)); });
  P.fn('pop', 1, (a, m) => {
    const [key, v] = stackVar(a, 'pop', m);
    if (!(v instanceof Cell)) throw err.badType('pop', '[]');
    m.setVar(key, v.rest);
    return v.first;
  });
  P.fn('queue', 2, (a, m) => {
    const [key, v] = stackVar(a, 'queue', m);
    const items = listToArray(v); items.push(a[1]);
    m.setVar(key, listFromArray(items));
  });
  P.fn('dequeue', 1, (a, m) => {
    const [key, v] = stackVar(a, 'dequeue', m);
    if (!(v instanceof Cell)) throw err.badType('dequeue', '[]');
    const items = listToArray(v);
    const last = items.pop();
    m.setVar(key, listFromArray(items));
    return last;
  });

  // ---- predicates --------------------------------------------------------------------------------------------------
  P.fn('wordp word?', 1, (a) => bool(isWord(a[0])));
  P.fn('listp list?', 1, (a) => bool(isList(a[0])));
  P.fn('arrayp array?', 1, (a) => bool(a[0] instanceof LArray));
  P.fn('emptyp empty?', 1, (a) => bool(a[0] === NIL || (isWord(a[0]) && wordText(a[0]) === '')));
  P.fn('numberp number?', 1, (a) => bool(isWord(a[0]) && numberValue(a[0]) !== null));
  P.fn('vbarredp vbarred? backslashedp backslashed?', 1, (a) => bool(a[0] instanceof QWord));
  P.fn('.eq', 2, (a) => bool(a[0] === a[1]));
  P.fn('beforep before?', 2, (a) => bool(wordArg(a[0], 'beforep').toLowerCase() < wordArg(a[1], 'beforep').toLowerCase()));

  P.fn('memberp member?', 2, (a) => {
    const thing = a[0], l = a[1];
    if (isList(l)) { for (let c = l; c instanceof Cell; c = c.rest) if (equalp(c.first, thing)) return 'true'; return 'false'; }
    if (l instanceof LArray) return bool(l.items.some((x) => equalp(x, thing)));
    if (isWord(l)) return bool(isWord(thing) && chars(wordText(thing)).length === 1 && chars(wordText(l)).some((c) => equalp(c, thing)));
    throw err.badType('memberp', showForm(l));
  });

  P.fn('substringp substring?', 2, (a) => {
    if (!isWord(a[0]) || !isWord(a[1])) return 'false';
    return bool(wordText(a[1]).toLowerCase().includes(wordText(a[0]).toLowerCase()));
  });

  // ---- queries -----------------------------------------------------------------------------------------------------
  P.fn('count', 1, (a) => {
    const x = a[0];
    if (isList(x)) return listLength(x);
    if (x instanceof LArray) return x.items.length;
    if (isWord(x)) return chars(wordText(x)).length;
    throw err.badType('count', showForm(x));
  });

  const asciiOf = (name) => (a) => {
    const t = wordArg(a[0], name);
    if (chars(t).length !== 1) throw err.badType(name, showForm(a[0]));
    return t.codePointAt(0);
  };
  P.fn('ascii', 1, asciiOf('ascii'));
  P.fn('rawascii', 1, asciiOf('rawascii'));
  P.fn('char', 1, (a) => {
    const n = int(a[0], 'char');
    if (n < 0 || n > 255) throw err.badValue('char', showForm(a[0]));
    return String.fromCharCode(n);
  });

  P.fn('member', 2, (a) => {
    const thing = a[0], l = a[1];
    if (isList(l)) { for (let c = l; c instanceof Cell; c = c.rest) if (equalp(c.first, thing)) return c; return NIL; }
    if (isWord(l)) {
      const cs = chars(wordText(l));
      for (let i = 0; i < cs.length; i++) if (equalp(cs[i], thing)) return cs.slice(i).join('');
      return '';
    }
    throw err.badType('member', showForm(l));
  });

  P.fn('lowercase', 1, (a) => wordArg(a[0], 'lowercase').toLowerCase());
  P.fn('uppercase', 1, (a) => wordArg(a[0], 'uppercase').toUpperCase());

  P.fn('parse', 1, (a) => listFromArray(parseText(wordArg(a[0], 'parse'))));
  P.fn('runparse', 1, (a) => {
    const x = a[0];
    // A barred word (|print 3+4|) is already protected text: it comes back whole, as one member (11.5 item 6). A word whose
    // protection was a backslash is not: the backslash is not part of its text, so runparse re-reads it and splits at the
    // paren or operator (runparse of the word a, backslash, paren, b is [a ( b] in the reference).
    const items = isList(x) ? listToArray(x) : (x instanceof QWord && !x.viaBackslash ? [x] : parseText(wordArg(x, 'runparse')));
    return listFromArray(runparse(items));
  });
}
