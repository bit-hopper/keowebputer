// Variables, property lists, procedure definition and inspection, and printing (LOGO.md 4.2; manual, VARIABLE DEFINITION,
// PROPERTY LISTS, PROCEDURE DEFINITION, WORKSPACE MANAGEMENT, COMMUNICATION / TRANSMITTERS). Trace, step, bury, edit, files
// and the terminal are later phases (LOGO.md section 10).

import { NIL, isList, isWord, wordText, nameKey, listFromArray, listToArray } from './data.js';
import { err } from './errors.js';
import { showForm, showText, printText, poValue, poName } from './printer.js';
import { wordArg, listArg, bool } from './prims.js';
import { buildProc, procText, titleLine } from './procdef.js';
import { isPrimRecord } from './prims.js';

// A CONTENTS-list argument (manual): a word (one procedure name), a list of words (procedure names), or a list of three
// lists [procedures variables plists]. Returns [procNames, varNames, plistNames] as arrays of words.
function contentsArg(x, who) {
  if (isWord(x)) return [[wordText(x)], [], []];
  if (!isList(x)) throw err.badType(who, showForm(x));
  const items = listToArray(x);
  if (items.length > 0 && isList(items[0])) {
    const out = [[], [], []];
    for (let k = 0; k < 3; k++) if (k < items.length) out[k] = listToArray(items[k]).map((w) => wordText(w));
    return out;
  }
  return [items.map((w) => wordText(w)), [], []];
}

export function install(P) {
  // ---- variables ---------------------------------------------------------------------------------------------------
  P.fn('make', 2, (a, m) => { m.setVar(nameKey(wordArg(a[0], 'make')), a[1]); });
  P.fn('name', 2, (a, m) => { m.setVar(nameKey(wordArg(a[1], 'name')), a[0]); });
  P.fn('thing', 1, (a, m) => m.lookupVar(nameKey(wordArg(a[0], 'thing')), wordText(a[0])));

  const declare = (who, f) => (a, m) => {
    const names = [];
    for (const x of a) {
      if (isList(x)) for (const w of listToArray(x)) names.push(wordArg(w, who));
      else names.push(wordArg(x, who));
    }
    for (const n of names) f(m, nameKey(n));
  };
  P.fn('local', 1, declare('local', (m, key) => m.declareLocal(key)), { min: 0, max: -1 });
  P.fn('global', 1, declare('global', (m, key) => { if (!m.vars.has(key) || m.vars.get(key).length === 0) m.vars.set(key, [{ v: NIL }]); }),
    { min: 0, max: -1 });
  P.fn('localmake', 2, (a, m) => {
    const key = nameKey(wordArg(a[0], 'localmake'));
    m.declareLocal(key);
    m.setVar(key, a[1]);
  });
  P.fn('namep name?', 1, (a, m) => bool(m.hasVar(nameKey(wordArg(a[0], 'namep')))));

  // ---- property lists ----------------------------------------------------------------------------------------------
  // A property list's [name, value] pairs, newest property first: that is the order PLIST and PO give (a PPROP on a property
  // that already exists changes its value and keeps its place).
  const plistEntries = (pl) => [...pl.values()].reverse();
  const plistOf = (m, name, create) => {
    const k = nameKey(name);
    let pl = m.interp.plists.get(k);
    if (!pl && create) { pl = new Map(); m.interp.plists.set(k, pl); }
    return pl;
  };
  P.fn('pprop', 3, (a, m) => {
    plistOf(m, wordArg(a[0], 'pprop'), true).set(wordArg(a[1], 'pprop').toLowerCase(), [wordText(a[1]), a[2]]);
  });
  P.fn('gprop', 2, (a, m) => {
    const pl = plistOf(m, wordArg(a[0], 'gprop'), false);
    const e = pl && pl.get(wordArg(a[1], 'gprop').toLowerCase());
    return e ? e[1] : NIL;
  });
  P.fn('remprop', 2, (a, m) => {
    const pl = plistOf(m, wordArg(a[0], 'remprop'), false);
    if (pl) { pl.delete(wordArg(a[1], 'remprop').toLowerCase()); if (pl.size === 0) m.interp.plists.delete(nameKey(wordText(a[0]))); }
  });
  P.fn('plist', 1, (a, m) => {
    const pl = plistOf(m, wordArg(a[0], 'plist'), false);
    const out = [];
    if (pl) for (const e of plistEntries(pl)) out.push(e[0], e[1]);
    return listFromArray(out);
  });
  P.fn('plistp plist?', 1, (a, m) => {
    const pl = plistOf(m, wordArg(a[0], 'plistp'), false);
    return bool(!!pl && pl.size > 0);
  });

  // ---- procedures: defining and describing ---------------------------------------------------------------------------
  P.fn('procedurep procedure?', 1, (a, m) => bool(m.interp.procs.has(nameKey(wordArg(a[0], 'procedurep')))));
  P.fn('primitivep primitive?', 1, (a, m) => {
    const p = m.interp.procs.get(nameKey(wordArg(a[0], 'primitivep')));
    return bool(p !== undefined && isPrimRecord(p));
  });
  P.fn('definedp defined?', 1, (a, m) => {
    const p = m.interp.procs.get(nameKey(wordArg(a[0], 'definedp')));
    return bool(p !== undefined && !isPrimRecord(p));
  });
  P.fn('arity', 1, (a, m) => {
    const p = m.interp.procs.get(nameKey(wordArg(a[0], 'arity')));
    if (p === undefined) throw err.unknownProc(wordText(a[0]));
    return listFromArray([p.min, p.def, p.max]);
  });
  const userProc = (m, x, who) => {
    const p = m.interp.procs.get(nameKey(wordArg(x, who)));
    if (p === undefined || p.fn !== undefined || p.op !== undefined) throw err.unknownProc(wordText(x));
    return p;
  };
  P.fn('text', 1, (a, m) => procText(userProc(m, a[0], 'text')));
  P.fn('fulltext', 1, (a, m) => {
    const p = userProc(m, a[0], 'fulltext');
    if (p.rawLines) return listFromArray(p.rawLines);
    // DEFINEd procedure: a list of lists that looks like a TO definition when printed one per line.
    return listFromArray([listFromArray(['to', p.name].concat(titleLine(p).split(' ').slice(2))), ...p.lines, listFromArray(['end'])]);
  });
  P.fn('define', 2, (a, m) => {
    const name = wordArg(a[0], 'define');
    const text = listToArray(listArg(a[1], 'define'));
    if (text.length === 0 || !isList(text[0])) throw err.badType('define', showForm(a[1]));
    m.interp.installProc(buildProc(name, listToArray(text[0]), text.slice(1), null), { redefine: true });
  });
  P.fn('.defmacro', 2, (a, m) => {
    const name = wordArg(a[0], '.defmacro');
    const text = listToArray(listArg(a[1], '.defmacro'));
    if (text.length === 0 || !isList(text[0])) throw err.badType('.defmacro', showForm(a[1]));
    const proc = buildProc(name, listToArray(text[0]), text.slice(1), null);
    proc.isMacro = true;
    m.interp.installProc(proc, { redefine: true });
  });
  P.fn('copydef', 2, (a, m) => {
    const newName = wordArg(a[0], 'copydef'), old = m.interp.procs.get(nameKey(wordArg(a[1], 'copydef')));
    if (old === undefined) throw err.unknownProc(wordText(a[1]));
    m.interp.copyProc(newName, old);
  });
  P.fn('macrop macro?', 1, (a, m) => {
    const p = m.interp.procs.get(nameKey(wordArg(a[0], 'macrop')));
    return bool(p !== undefined && p.isMacro === true);
  });

  // ---- workspace queries -------------------------------------------------------------------------------------------
  // PROCEDURES, NAMES, PLISTS, CONTENTS and the PO family list in alphabetical order, as the reference does.
  const byName = (a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
  const userProcNames = (m) => [...m.interp.procs.values()].filter((p) => p.fn === undefined && p.op === undefined && !p.library).map((p) => p.name).sort(byName);
  const globalNames = (m) => [...m.vars.entries()].filter(([k, st]) => st.length > 0 && !m.interp.systemVars.has(k)).map(([k]) => k).sort(byName);
  const plistNames = (m) => [...m.interp.plists.keys()].sort(byName);

  P.fn('procedures', 0, (a, m) => listFromArray(userProcNames(m)));
  P.fn('primitives', 0, (a, m) => listFromArray([...m.interp.procs.values()].filter((p) => isPrimRecord(p) && !p.key.startsWith('tpn:')).map((p) => p.name)));
  P.fn('names', 0, (a, m) => listFromArray([NIL, listFromArray(globalNames(m))]));
  P.fn('plists', 0, (a, m) => listFromArray([NIL, NIL, listFromArray(plistNames(m))]));
  P.fn('contents', 0, (a, m) => listFromArray([listFromArray(userProcNames(m)), listFromArray(globalNames(m)), listFromArray(plistNames(m))]));
  P.fn('namelist', 1, (a) => listFromArray([NIL, isList(a[0]) ? a[0] : listFromArray([a[0]])]));
  P.fn('pllist', 1, (a) => listFromArray([NIL, NIL, isList(a[0]) ? a[0] : listFromArray([a[0]])]));

  // ---- erasing -----------------------------------------------------------------------------------------------------
  const eraseNames = (m, procs, vars, pls) => {
    for (const n of procs) {
      const p = m.interp.procs.get(nameKey(n));
      if (p === undefined) continue;
      if (isPrimRecord(p) && !m.interp.redefp()) throw err.isPrimitive(n);
      m.interp.eraseProc(n);
    }
    for (const n of vars) { const st = m.vars.get(nameKey(n)); if (st) st.length = 0; }
    for (const n of pls) m.interp.plists.delete(nameKey(n));
  };
  P.fn('erase er', 1, (a, m) => { const [p, v, l] = contentsArg(a[0], 'erase'); eraseNames(m, p, v, l); });
  P.fn('erall', 0, (a, m) => eraseNames(m, userProcNames(m), globalNames(m), plistNames(m)));
  P.fn('erps', 0, (a, m) => eraseNames(m, userProcNames(m), [], []));
  P.fn('erns', 0, (a, m) => eraseNames(m, [], globalNames(m), []));
  P.fn('erpls', 0, (a, m) => eraseNames(m, [], [], plistNames(m)));
  P.fn('ern', 1, (a, m) => eraseNames(m, [], contentsArg(isList(a[0]) ? a[0] : listFromArray([a[0]]), 'ern')[0], []));
  P.fn('erpl', 1, (a, m) => eraseNames(m, [], [], contentsArg(isList(a[0]) ? a[0] : listFromArray([a[0]]), 'erpl')[0]));

  // ---- printing ---------------------------------------------------------------------------------------------------
  P.fn('print pr', 1, (a, m) => { m.interp.out(a.map(printText).join(' ') + '\n'); }, { min: 0, max: -1 });
  P.fn('show', 1, (a, m) => { m.interp.out(a.map(showText).join(' ') + '\n'); }, { min: 0, max: -1 });
  P.fn('type', 1, (a, m) => { m.interp.out(a.map(printText).join('')); }, { min: 0, max: -1 });

  // PO / POT: procedure definitions, variables, property lists (manual, INSPECTION).
  const printProc = (m, p, titleOnly) => {
    if (titleOnly) { m.interp.out(titleLine(p) + '\n'); return; }
    if (p.rawLines) m.interp.out(p.rawLines.join('\n') + '\n\n');
    else {
      m.interp.out(titleLine(p) + '\n');
      for (const l of p.lines) m.interp.out(printText(l) + '\n');
      m.interp.out('end\n\n');
    }
  };
  const po = (titleOnly) => (a, m) => {
    const [procs, vars, pls] = contentsArg(a[0], 'po');
    for (const n of procs) { const p = m.interp.procs.get(nameKey(n)); if (p === undefined) throw err.unknownProc(n); if (p.fn === undefined && p.op === undefined) printProc(m, p, titleOnly); }
    for (const n of vars) m.interp.out('Make ' + poName(n) + ' ' + poValue(m.lookupVar(nameKey(n), n)) + '\n');
    for (const n of pls) {
      const pl = m.interp.plists.get(nameKey(n));
      if (pl) for (const e of plistEntries(pl)) m.interp.out('Pprop ' + poName(n) + ' ' + poName(e[0]) + ' ' + poValue(e[1]) + '\n');
    }
  };
  P.fn('printout po', 1, po(false));
  P.fn('pot', 1, po(true));
  P.fn('poall', 0, (a, m) => po(false)([listFromArray([listFromArray(userProcNames(m)), listFromArray(globalNames(m)), listFromArray(plistNames(m))])], m));
  P.fn('pops', 0, (a, m) => po(false)([listFromArray(userProcNames(m))], m));
  P.fn('pots', 0, (a, m) => po(true)([listFromArray(userProcNames(m))], m));
  P.fn('pons', 0, (a, m) => po(false)([listFromArray([NIL, listFromArray(globalNames(m))])], m));

  // ---- special variables and a few reference oddities ----------------------------------------------------------------
  // CASEIGNOREDP is also callable as a primitive in the reference (print caseignoredp prints true; 11.5 item 6).
  P.fn('caseignoredp', 0, () => 'true');
}
