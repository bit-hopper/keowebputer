// The initial basis (MLspec.md section 5.6).
//   core    types  int bool exn unit
//           values true false not ~ + - * div mod < > <= >= = <>   (the four comparisons work on int, string and char)
//           exceptions  Div Overflow Match Bind
//   lists   (the default; `makeBasis({ lists: false })` leaves it out, to test that book programs behave the same either way)
//           types  string char 'a list 'a option
//           values nil :: NONE SOME  ^ @ size hd tl null length rev print str ord chr explode implode concat  Int.toString
//           exceptions  Empty Option Chr
//   (`map`, `isSome` and `valOf` are ML source: see PRELUDE in interpreter.js, because a JS primitive cannot apply a closure.)
// The returned scope is the root every cell's environment extends; it is never modified after this function returns.
import {
  Scope, TVar, tfn, ttuple, tList, tOption, tInt, tBool, tExn, tUnit, tString, tChar,
  INT, BOOL, EXN, STRING, CHAR, LIST, OPTION,
} from './types.js';

// datatype bool = false | true. Made once per process (not per basis): the machine hands out these very objects as the results
// of comparisons, so every interpreter's `true` and `false` must be the same ConInfo.
const boolInfo = (name, index) => ({ kind: 'con', name, scheme: tBool, tyname: BOOL, hasArg: false, index });
export const FALSE_INFO = boolInfo('false', 0);
export const TRUE_INFO = boolInfo('true', 1);
BOOL.cons = [{ name: 'false', ty: null, info: FALSE_INFO }, { name: 'true', ty: null, info: TRUE_INFO }];

// datatype 'a list = nil | :: of 'a * 'a list     and     datatype 'a option = NONE | SOME of 'a
// Constructor indexes are part of the contract: the machine compares constructors by index, and builds lists from these.
const generic = () => { const v = new TVar(0); v.generic = true; return v; };
const listVar = generic();
export const NIL_INFO = { kind: 'con', name: 'nil', scheme: tList(listVar), tyname: LIST, hasArg: false, index: 0 };
const consArg = ttuple([listVar, tList(listVar)]);
export const CONS_INFO = { kind: 'con', name: '::', scheme: tfn(consArg, tList(listVar)), tyname: LIST, hasArg: true, index: 1 };
LIST.params = [listVar];
LIST.cons = [{ name: 'nil', ty: null, info: NIL_INFO }, { name: '::', ty: consArg, info: CONS_INFO }];

const optionVar = generic();
export const NONE_INFO = { kind: 'con', name: 'NONE', scheme: tOption(optionVar), tyname: OPTION, hasArg: false, index: 0 };
export const SOME_INFO = { kind: 'con', name: 'SOME', scheme: tfn(optionVar, tOption(optionVar)), tyname: OPTION, hasArg: true, index: 1 };
OPTION.params = [optionVar];
OPTION.cons = [{ name: 'NONE', ty: null, info: NONE_INFO }, { name: 'SOME', ty: optionVar, info: SOME_INFO }];

// Does this root scope carry the lists-and-strings basis? (Elaboration of `[..]`, string and char literals asks.)
export const hasListBasis = (root) => root.vals.get('nil') === NIL_INFO;

export function makeBasis(options = {}) {
  const root = new Scope();

  root.types.set('int', { kind: 'tyname', tyname: INT });
  root.types.set('exn', { kind: 'tyname', tyname: EXN });
  root.types.set('bool', { kind: 'tyname', tyname: BOOL });
  root.types.set('unit', { kind: 'abbrev', params: [], body: tUnit });

  root.vals.set('false', FALSE_INFO);
  root.vals.set('true', TRUE_INFO);

  const prim = (name, scheme, into = root) => into.vals.set(name.replace(/^.*\./, ''), { kind: 'prim', name, scheme });
  const intPair = ttuple([tInt, tInt]);
  prim('not', tfn(tBool, tBool));
  prim('~', tfn(tInt, tInt));
  for (const op of ['+', '-', '*', 'div', 'mod']) prim(op, tfn(intPair, tInt));
  for (const op of ['<', '>', '<=', '>=']) { // overloaded on int, string and char; int unless something else decides (types.js: ORDERED)
    const a = generic();
    a.ord = true;
    prim(op, tfn(ttuple([a, a]), tBool));
  }
  for (const op of ['=', '<>']) {
    const a = generic();
    a.eq = true;
    prim(op, tfn(ttuple([a, a]), tBool));
  }

  for (const name of ['Div', 'Overflow', 'Match', 'Bind']) {
    root.vals.set(name, { kind: 'exn', name, scheme: tExn, hasArg: false, basis: true });
  }

  if (options.lists === false) return root;

  root.types.set('string', { kind: 'tyname', tyname: STRING });
  root.types.set('char', { kind: 'tyname', tyname: CHAR });
  root.types.set('list', { kind: 'tyname', tyname: LIST });
  root.types.set('option', { kind: 'tyname', tyname: OPTION });
  for (const info of [NIL_INFO, CONS_INFO, NONE_INFO, SOME_INFO]) root.vals.set(info.name, info);

  const a = generic();
  const strPair = ttuple([tString, tString]);
  prim('^', tfn(strPair, tString));
  prim('@', tfn(ttuple([tList(a), tList(a)]), tList(a)));
  prim('size', tfn(tString, tInt));
  prim('hd', tfn(tList(a), a));
  prim('tl', tfn(tList(a), tList(a)));
  prim('null', tfn(tList(a), tBool));
  prim('length', tfn(tList(a), tInt));
  prim('rev', tfn(tList(a), tList(a)));
  prim('print', tfn(tString, tUnit));
  prim('str', tfn(tChar, tString));
  prim('ord', tfn(tChar, tInt));
  prim('chr', tfn(tInt, tChar));
  prim('explode', tfn(tString, tList(tChar)));
  prim('implode', tfn(tList(tChar), tString));
  prim('concat', tfn(tList(tString), tString));

  const intEnv = new Scope();
  prim('Int.toString', tfn(tInt, tString), intEnv);
  root.strs.set('Int', { env: intEnv });

  for (const name of ['Empty', 'Option', 'Chr']) {
    root.vals.set(name, { kind: 'exn', name, scheme: tExn, hasArg: false, basis: true });
  }
  return root;
}
