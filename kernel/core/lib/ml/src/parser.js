// Parser for the accepted subset of MLspec.md section 5.3. Recursive descent over the lazy lexer, producing
// surface syntax (case, andalso, orelse and the derived functor forms are expanded later, by derive.js).
//
// Items are parsed one at a time so the caller can check and run each before the next is read:
//   const p = new Parser(source);
//   for (let item; (item = p.nextItem()); ) { ... }
// An item whose text is prefixed with ⊗ that fails to parse does not throw: nextItem returns
// { kind: 'bad', expectRejected: true, error } after skipping to the end of the item.
//
// Every node has loc = { line, col, start, end } (1-based line/col of its first token; start/end offsets).
//
// Nodes (kind, fields):
//   items   val{binds:[{rec,pat,exp}]}  fun{binds:[{name,clauses:[{pats,resultTy,exp}]}]}
//           datatype{binds:[{tyvars,name,cons:[{name,ty}]}]}  type{binds:[{tyvars,name,ty}]}
//           exception{binds:[{name,ty}]}  local{head,body}  signature{binds:[{name,sig}]}
//           structure{binds:[{name,ascription,body}]}  functor{name,param,ascription,body}
//           expstmt{exp}  pragma{name,value}  bad{error}
//   exps    int{value} string{value} char{value} list{items} var{name,qual} tuple{items} app{fn,arg,infix?} typed{exp,ty} andalso/orelse{left,right}
//           if{cond,then,else} case{exp,match} fn{match} let{decs,body} seq{exps} raise{exp} handle{exp,match}
//   pats    wild  pint{value} pstring{value} pchar{value} plist{items} pid{name,qual} pcon{con,arg} ptuple{items} ptyped{pat,ty}
//           (p :: q is pcon{con: pid '::' basis, arg: ptuple[p, q]}; x :: y in an expression is app{fn: var '::' basis})
//   types   tyvar{name,eq} tycon{name,qual,args} ttuple{items} arrow{from,to}
//   sigexp  sig{specs} sigid{name} where{sig,tyvars,tycon,ty}
//   specs   sigtype{tyvars,name} sigval{name,ty} sigexn{name,ty} sigstruct{name,sig} sharing{tycons}
//   strexp  struct{decs} strid{name,qual} apply{fun,arg} ascribe{str,sig,opaque} letstr{decs,body}
//           (an apply arg is a strexp or decs{decs}, the derived `F(structure a = X ...)` form)
import { Lexer } from './lexer.js';
import { MLError, syntaxError, ungrammatical } from './errors.js';

const INFIX = {
  '*': 7, div: 7, mod: 7,
  '+': 6, '-': 6, '^': 6,
  '::': 5, '@': 5,
  '=': 4, '<>': 4, '<': 4, '>': 4, '<=': 4, '>=': 4,
};
const RIGHT_ASSOC = new Set(['::', '@']);

const DEC_STARTERS = new Set([
  'val', 'fun', 'datatype', 'type', 'exception', 'local', 'signature', 'structure', 'functor',
  'open', 'abstype', 'infix', 'infixr', 'nonfix', 'eqtype', 'include', 'withtype',
]);

export class Parser {
  constructor(source) {
    this.src = source;
    this.lex = new Lexer(source);
    this.buf = [];
    this.prevEnd = 0;
  }

  // ---- token plumbing ----------------------------------------------------------------------------

  peek(n = 0) {
    while (this.buf.length <= n) this.buf.push(this.lex.next());
    return this.buf[n];
  }

  take() {
    const t = this.peek();
    this.buf.shift();
    this.prevEnd = t.end;
    return t;
  }

  isOp(t, v) { return t.type === 'op' && t.value === v; }
  isKw(t, v) { return t.type === 'kw' && t.value === v; }
  atOp(v, n = 0) { return this.isOp(this.peek(n), v); }
  atKw(v, n = 0) { return this.isKw(this.peek(n), v); }

  acceptOp(v) { if (this.atOp(v)) { return this.take(); } return null; }
  acceptKw(v) { if (this.atKw(v)) { return this.take(); } return null; }
  expectOp(v, what) { return this.atOp(v) ? this.take() : this.unexpected(this.peek(), what || "'" + v + "'"); }
  expectKw(v, what) { return this.atKw(v) ? this.take() : this.unexpected(this.peek(), what || "'" + v + "'"); }

  mk(kind, from, fields) {
    const n = Object.assign({ kind }, fields);
    n.loc = { line: from.line, col: from.col, start: from.start, end: this.prevEnd };
    return n;
  }

  describe(t) {
    if (t.type === 'eof') return 'the end of the program';
    if (t.type === 'int') return 'the number ' + t.text;
    if (t.type === 'pragma') return 'a pragma';
    if (t.type === 'string') return 'the string ' + JSON.stringify(t.value);
    if (t.type === 'char') return 'the character #' + JSON.stringify(t.value);
    return "'" + (t.type === 'id' && t.qual ? t.qual.join('.') + '.' : '') + t.value + "'";
  }

  // The one place a token that does not fit is turned into an error, so the book's vocabulary and the
  // "not part of the core" answers are uniform.
  unexpected(t, expecting) {
    if (t.type === 'eof') throw syntaxError('the program ends too soon' + (expecting ? '; expected ' + expecting : ''), t);
    if (t.type === 'ellipsis') throw ungrammatical(t.value + ' is a placeholder in the book, not part of a program', t);
    if (t.type === 'kw') {
      const why = {
        abstype: 'abstype is', open: 'open is', infix: 'infix declarations are', infixr: 'infix declarations are',
        nonfix: 'infix declarations are', eqtype: 'eqtype is', include: 'include is', withtype: 'withtype is',
        while: 'while loops are', do: 'while loops are', as: 'as patterns are', with: "'with' is",
      }[t.value];
      if (why) throw syntaxError(why + ' not part of the core the book uses', t);
    }
    if (t.type === 'op' && (t.value === '{' || t.value === '}' || t.value === '#')) throw syntaxError('records are not part of the core the book uses', t);
    if (t.type === 'sym' && t.value === ':=') throw syntaxError('the operator := is not part of the core the book uses (there are no references)', t);
    throw syntaxError('unexpected ' + this.describe(t) + (expecting ? '; expected ' + expecting : ''), t);
  }

  // ---- items ---------------------------------------------------------------------------------------

  // Next top-level item, or null at the end of the source.
  nextItem() {
    while (this.atOp(';')) this.take();
    const first = this.peek();
    if (first.type === 'eof') return null;
    if (first.type === 'pragma') {
      this.take();
      return this.mk('pragma', first, { name: first.name, value: first.value });
    }
    let expectRejected = false;
    let start = first;
    if (this.isOp(first, '⊗')) { this.take(); expectRejected = true; start = this.peek(); }
    let item;
    try {
      item = this.parseItem();
    } catch (e) {
      if (!(e instanceof MLError) || !expectRejected) throw e;
      const end = this.recover();
      const bad = { kind: 'bad', error: e, expectRejected: true, loc: { line: first.line, col: first.col, start: first.start, end } };
      bad.text = this.src.slice(start.start, end);
      return bad;
    }
    if (expectRejected) item.expectRejected = true;
    item.text = this.src.slice(start.start, item.loc.end);
    this.acceptOp(';');
    return item;
  }

  parseAll() {
    const items = [];
    for (let it; (it = this.nextItem());) items.push(it);
    return items;
  }

  parseItem() {
    const t = this.peek();
    if (t.type === 'kw' && DEC_STARTERS.has(t.value)) {
      return this.parseDec();
    }
    const from = t;
    const exp = this.parseExp();
    const after = this.peek();
    if (!this.isOp(after, ';') && after.type !== 'eof') this.unexpected(after, "';' after the expression");
    return this.mk('expstmt', from, { exp });
  }

  // Skip the rest of a rejected item, returning the offset where it ends (before the ; that closes it): to the next ';' outside any let/local/struct/sig ... end or ( ... ) opened
  // after the error. Lexical errors met while skipping are swallowed (the lexer has already moved past them).
  recover() {
    let depth = 0;
    let end = this.prevEnd;
    for (;;) {
      let t;
      try { t = this.peek(); } catch (e) { if (e instanceof MLError) continue; throw e; }
      if (t.type === 'eof') return end;
      if (this.isOp(t, ';') && depth === 0) { this.take(); return end; }
      if (t.type === 'kw' && ['let', 'local', 'struct', 'sig'].includes(t.value)) depth++;
      else if (t.type === 'kw' && t.value === 'end' && depth > 0) depth--;
      else if (this.isOp(t, '(')) depth++;
      else if (this.isOp(t, ')') && depth > 0) depth--;
      this.take();
      end = this.prevEnd;
    }
  }

  // ---- declarations -------------------------------------------------------------------------------

  // decs up to (not including) a token that cannot start one: in, end, ), eof.
  parseDecSeq() {
    const decs = [];
    for (;;) {
      while (this.atOp(';')) this.take();
      const t = this.peek();
      if (t.type === 'kw' && DEC_STARTERS.has(t.value)) decs.push(this.parseDec());
      else return decs;
    }
  }

  parseDec() {
    const t = this.peek();
    switch (t.value) {
      case 'val': return this.parseVal();
      case 'fun': return this.parseFun();
      case 'datatype': return this.parseDatatype();
      case 'type': return this.parseTypeDec();
      case 'exception': return this.parseException();
      case 'local': return this.parseLocal();
      case 'signature': return this.parseSignature();
      case 'structure': return this.parseStructure();
      case 'functor': return this.parseFunctor();
      default: return this.unexpected(t, 'a declaration');
    }
  }

  parseVal() {
    const from = this.take();
    const binds = [];
    do {
      const rec = !!this.acceptKw('rec');
      const pat = this.parsePat();
      this.expectOp('=');
      const exp = this.parseExp();
      binds.push({ rec, pat, exp });
    } while (this.acceptKw('and'));
    return this.mk('val', from, { binds });
  }

  parseFun() {
    const from = this.take();
    const binds = [];
    do {
      const bindFrom = this.peek();
      const clauses = [];
      let name = null;
      let arity = 0;
      do {
        const head = this.peek();
        if (head.type !== 'id' || head.qual) this.unexpected(head, 'a function name');
        this.take();
        if (name === null) name = head.value;
        else if (head.value !== name) throw syntaxError('every clause of a function must define the same name: found ' + head.value + ' after ' + name, head);
        const pats = [];
        while (this.startsAtpat(this.peek())) pats.push(this.parseAtpat());
        if (pats.length === 0) this.unexpected(this.peek(), 'an argument pattern after ' + name);
        if (arity === 0) arity = pats.length;
        else if (pats.length !== arity) throw syntaxError('every clause of ' + name + ' must take the same number of arguments: ' + arity + ' before, ' + pats.length + ' here', head);
        let resultTy = null;
        if (this.acceptOp(':')) resultTy = this.parseType();
        this.expectOp('=');
        const exp = this.parseExp();
        clauses.push({ pats, resultTy, exp });
      } while (this.acceptOp('|'));
      binds.push({ name, clauses, loc: { line: bindFrom.line, col: bindFrom.col, start: bindFrom.start, end: this.prevEnd } });
    } while (this.acceptKw('and'));
    return this.mk('fun', from, { binds });
  }

  // 'a  |  ('a, 'b)  |  nothing
  parseTyVars() {
    const t = this.peek();
    if (t.type === 'tyvar') { this.take(); return [t.value]; }
    if (this.isOp(t, '(') && this.peek(1).type === 'tyvar') {
      this.take();
      const vars = [];
      do {
        const v = this.peek();
        if (v.type !== 'tyvar') this.unexpected(v, 'a type variable');
        this.take();
        vars.push(v.value);
      } while (this.acceptOp(','));
      this.expectOp(')');
      return vars;
    }
    return [];
  }

  parseDatatype() {
    const from = this.take();
    const binds = [];
    do {
      const bindFrom = this.peek();
      let tyvars = [];
      if (this.atOp('(')) {
        // ( ... ) head: every element must be a type variable
        this.take();
        do {
          const v = this.peek();
          if (v.type !== 'tyvar') throw ungrammatical("a datatype head takes type variables like 'a, not types; found " + this.describe(v), v);
          this.take();
          tyvars.push(v.value);
        } while (this.acceptOp(','));
        this.expectOp(')');
      } else if (this.peek().type === 'tyvar') {
        tyvars = [this.take().value];
      }
      const nameTok = this.peek();
      if (nameTok.type !== 'id' || nameTok.qual) this.unexpected(nameTok, 'a type name');
      this.take();
      const next = this.peek();
      if (next.type === 'id') {
        throw ungrammatical("a datatype head takes type variables like 'a, not types; found " + nameTok.value + ' before ' + next.value, nameTok);
      }
      this.expectOp('=');
      const cons = [];
      do {
        const c = this.peek();
        if (c.type !== 'id' || c.qual) this.unexpected(c, 'a constructor name');
        this.take();
        let ty = null;
        if (this.acceptKw('of')) ty = this.parseType();
        cons.push({ name: c.value, ty, loc: { line: c.line, col: c.col, start: c.start, end: this.prevEnd } });
      } while (this.acceptOp('|'));
      binds.push({ tyvars, name: nameTok.value, cons, loc: { line: bindFrom.line, col: bindFrom.col, start: bindFrom.start, end: this.prevEnd } });
    } while (this.acceptKw('and'));
    return this.mk('datatype', from, { binds });
  }

  parseTypeDec() {
    const from = this.take();
    const binds = [];
    do {
      const tyvars = this.parseTyVars();
      const nameTok = this.peek();
      if (nameTok.type !== 'id' || nameTok.qual) this.unexpected(nameTok, 'a type name');
      this.take();
      this.expectOp('=');
      binds.push({ tyvars, name: nameTok.value, ty: this.parseType() });
    } while (this.acceptKw('and'));
    return this.mk('type', from, { binds });
  }

  parseException() {
    const from = this.take();
    const binds = [];
    do {
      const c = this.peek();
      if (c.type !== 'id' || c.qual) this.unexpected(c, 'an exception name');
      this.take();
      let ty = null;
      if (this.acceptKw('of')) ty = this.parseType();
      binds.push({ name: c.value, ty });
    } while (this.acceptKw('and'));
    return this.mk('exception', from, { binds });
  }

  parseLocal() {
    const from = this.take();
    const head = this.parseDecSeq();
    this.expectKw('in');
    const body = this.parseDecSeq();
    this.expectKw('end');
    return this.mk('local', from, { head, body });
  }

  // ---- modules ------------------------------------------------------------------------------------

  idName(what) {
    const t = this.peek();
    if (t.type !== 'id' || t.qual) this.unexpected(t, what);
    this.take();
    return t.value;
  }

  parseSignature() {
    const from = this.take();
    const binds = [];
    do {
      const name = this.idName('a signature name');
      this.expectOp('=');
      binds.push({ name, sig: this.parseSigExp() });
    } while (this.acceptKw('and'));
    return this.mk('signature', from, { binds });
  }

  parseSigExp() {
    const from = this.peek();
    let sig;
    if (this.acceptKw('sig')) {
      const specs = this.parseSpecs();
      this.expectKw('end');
      sig = this.mk('sig', from, { specs });
    } else {
      const name = this.idName('a signature');
      sig = this.mk('sigid', from, { name });
    }
    while (this.atKw('where') || (this.atKw('and') && this.atKw('type', 1) && sig.kind === 'where')) {
      this.take();
      this.expectKw('type');
      const tyvars = this.parseTyVars();
      const tc = this.peek();
      if (tc.type !== 'id') this.unexpected(tc, 'a type name');
      this.take();
      this.expectOp('=');
      const ty = this.parseType();
      sig = this.mk('where', from, { sig, tyvars, tycon: { name: tc.value, qual: tc.qual }, ty });
    }
    return sig;
  }

  parseSpecs() {
    const specs = [];
    for (;;) {
      while (this.atOp(';')) this.take();
      const t = this.peek();
      if (t.type !== 'kw') return specs;
      if (t.value === 'type') {
        this.take();
        const tyvars = this.parseTyVars();
        const name = this.idName('a type name');
        if (this.atOp('=')) throw syntaxError("a signature leaves a type open; fix it with 'where type', not with =", this.peek());
        specs.push(this.mk('sigtype', t, { tyvars, name }));
      } else if (t.value === 'val') {
        this.take();
        do {
          const name = this.idName('a value name');
          this.expectOp(':');
          specs.push(this.mk('sigval', t, { name, ty: this.parseType() }));
        } while (this.acceptKw('and'));
      } else if (t.value === 'exception') {
        this.take();
        const name = this.idName('an exception name');
        let ty = null;
        if (this.acceptKw('of')) ty = this.parseType();
        specs.push(this.mk('sigexn', t, { name, ty }));
      } else if (t.value === 'structure') {
        this.take();
        const name = this.idName('a structure name');
        this.expectOp(':');
        specs.push(this.mk('sigstruct', t, { name, sig: this.parseSigExp() }));
      } else if (t.value === 'sharing') {
        this.take();
        this.expectKw('type');
        const tycons = [];
        do {
          const tc = this.peek();
          if (tc.type !== 'id') this.unexpected(tc, 'a type name');
          this.take();
          tycons.push({ name: tc.value, qual: tc.qual });
        } while (this.acceptOp('='));
        if (tycons.length < 2) this.unexpected(this.peek(), "'=' and a second type");
        specs.push(this.mk('sharing', t, { tycons }));
      } else if (t.value === 'datatype' || t.value === 'eqtype' || t.value === 'include') {
        this.unexpected(t);
      } else return specs;
    }
  }

  parseStructure() {
    const from = this.take();
    const binds = [];
    do {
      const name = this.idName('a structure name');
      let ascription = null;
      if (this.atOp(':') || this.atOp(':>')) {
        const opaque = this.take().value === ':>';
        ascription = { sig: this.parseSigExp(), opaque };
      }
      this.expectOp('=');
      binds.push({ name, ascription, body: this.parseStrExp() });
    } while (this.acceptKw('and'));
    return this.mk('structure', from, { binds });
  }

  parseFunctor() {
    const from = this.take();
    const name = this.idName('a functor name');
    this.expectOp('(');
    let param;
    const pFrom = this.peek();
    if (this.atOp(')')) {
      param = this.mk('specs', pFrom, { specs: [] });
    } else if (this.peek().type === 'id' && this.atOp(':', 1)) {
      const strid = this.take().value;
      this.take();
      param = this.mk('named', pFrom, { strid, sig: this.parseSigExp() });
    } else {
      param = this.mk('specs', pFrom, { specs: this.parseSpecs() });
    }
    this.expectOp(')');
    let ascription = null;
    if (this.atOp(':') || this.atOp(':>')) {
      const opaque = this.take().value === ':>';
      ascription = { sig: this.parseSigExp(), opaque };
    }
    this.expectOp('=');
    return this.mk('functor', from, { name, param, ascription, body: this.parseStrExp() });
  }

  parseStrExp() {
    const from = this.peek();
    let str;
    if (this.acceptKw('struct')) {
      const decs = this.parseDecSeq();
      this.expectKw('end');
      str = this.mk('struct', from, { decs });
    } else if (this.acceptKw('let')) {
      const decs = this.parseDecSeq();
      this.expectKw('in');
      const body = this.parseStrExp();
      this.expectKw('end');
      str = this.mk('letstr', from, { decs, body });
    } else {
      const t = this.peek();
      if (t.type !== 'id') this.unexpected(t, 'a structure expression');
      this.take();
      if (this.atOp('(') && !t.qual) {
        this.take();
        const argFrom = this.peek();
        let arg;
        if (this.atOp(')')) arg = this.mk('decs', argFrom, { decs: [] });
        else if (this.atKw('structure')) arg = this.mk('decs', argFrom, { decs: this.parseDecSeq() });
        else arg = this.parseStrExp();
        this.expectOp(')');
        str = this.mk('apply', from, { fun: t.value, arg });
      } else {
        str = this.mk('strid', from, { name: t.value, qual: t.qual });
      }
    }
    while (this.atOp(':') || this.atOp(':>')) {
      const opaque = this.take().value === ':>';
      str = this.mk('ascribe', from, { str, sig: this.parseSigExp(), opaque });
    }
    return str;
  }

  // ---- expressions --------------------------------------------------------------------------------

  parseExp() {
    const from = this.peek();
    let e = this.parseOrelse();
    while (this.atKw('handle')) {
      this.take();
      e = this.mk('handle', from, { exp: e, match: this.parseMatch() });
    }
    return e;
  }

  parseOrelse() {
    const from = this.peek();
    const left = this.parseAndalso();
    if (this.acceptKw('orelse')) return this.mk('orelse', from, { left, right: this.parseOrelse() });
    return left;
  }

  parseAndalso() {
    const from = this.peek();
    const left = this.parseTyped();
    if (this.acceptKw('andalso')) return this.mk('andalso', from, { left, right: this.parseAndalso() });
    return left;
  }

  parseTyped() {
    const from = this.peek();
    let e;
    if (this.acceptKw('if')) {
      const cond = this.parseExp();
      this.expectKw('then');
      const thenE = this.parseExp();
      this.expectKw('else');
      e = this.mk('if', from, { cond, then: thenE, else: this.parseExp() });
    } else if (this.acceptKw('case')) {
      const exp = this.parseExp();
      this.expectKw('of');
      e = this.mk('case', from, { exp, match: this.parseMatch() });
    } else if (this.acceptKw('fn')) {
      e = this.mk('fn', from, { match: this.parseMatch() });
    } else if (this.acceptKw('raise')) {
      e = this.mk('raise', from, { exp: this.parseExp() });
    } else {
      e = this.parseInfix(0);
    }
    while (this.atOp(':')) {
      this.take();
      e = this.mk('typed', from, { exp: e, ty: this.parseType() });
    }
    return e;
  }

  // The infix operator at the next token, as { name, prec }, or null. A symbol that is not in the fixed
  // table is an error, not "not an operator": it can only have been meant as one.
  peekInfix() {
    const t = this.peek();
    let name = null;
    if (t.type === 'sym') name = t.value;
    else if (t.type === 'op' && t.value === '=') name = '=';
    else if (t.type === 'id' && !t.qual && (t.value === 'div' || t.value === 'mod')) name = t.value;
    if (name === null) return null;
    if (INFIX[name] === undefined) this.unexpected(t, 'an operator');
    return { name, prec: INFIX[name] };
  }

  parseInfix(minPrec) {
    const from = this.peek();
    let left = this.parseApp();
    for (;;) {
      const op = this.peekInfix();
      if (!op || op.prec < minPrec) return left;
      const opTok = this.take();
      const right = this.parseInfix(RIGHT_ASSOC.has(op.name) ? op.prec : op.prec + 1);
      const fn = { kind: 'var', name: op.name, qual: null, basis: op.name === '::', loc: { line: opTok.line, col: opTok.col, start: opTok.start, end: opTok.end } };
      const arg = { kind: 'tuple', items: [left, right], loc: { line: from.line, col: from.col, start: from.start, end: this.prevEnd } };
      left = this.mk('app', from, { fn, arg, infix: true });
    }
  }

  startsAtexp(t) {
    if (t.type === 'int' || t.type === 'string' || t.type === 'char') return true;
    if (t.type === 'id') return t.qual || (t.value !== 'div' && t.value !== 'mod');
    if (t.type === 'sym') return t.value === '~';
    if (t.type === 'kw') return t.value === 'op' || t.value === 'let';
    return t.type === 'op' && (t.value === '(' || t.value === '[');
  }

  parseApp() {
    const from = this.peek();
    let e = this.parseAtexp();
    while (this.startsAtexp(this.peek())) {
      const arg = this.parseAtexp();
      e = this.mk('app', from, { fn: e, arg });
    }
    return e;
  }

  parseAtexp() {
    const t = this.peek();
    if (t.type === 'int') { this.take(); return this.mk('int', t, { value: t.value }); }
    if (t.type === 'string') { this.take(); return this.mk('string', t, { value: t.value }); }
    if (t.type === 'char') { this.take(); return this.mk('char', t, { value: t.value }); }
    if (this.isOp(t, '[')) {
      this.take();
      const items = [];
      if (!this.acceptOp(']')) {
        do items.push(this.parseExp()); while (this.acceptOp(','));
        this.expectOp(']', "',' or ']'");
      }
      return this.mk('list', t, { items });
    }
    if (t.type === 'id') { this.take(); return this.mk('var', t, { name: t.value, qual: t.qual }); }
    if (t.type === 'sym' && t.value === '~') { this.take(); return this.mk('var', t, { name: '~', qual: null }); }
    if (this.isKw(t, 'op')) {
      this.take();
      const o = this.peek();
      if (o.type === 'id' || o.type === 'sym' || this.isOp(o, '=')) { this.take(); return this.mk('var', t, { name: o.value, qual: o.qual || null }); }
      return this.unexpected(o, 'an operator after op');
    }
    if (this.isKw(t, 'let')) {
      this.take();
      const decs = this.parseDecSeq();
      this.expectKw('in');
      const exps = [this.parseExp()];
      while (this.acceptOp(';')) exps.push(this.parseExp());
      this.expectKw('end');
      const body = exps.length === 1 ? exps[0] : this.mk('seq', t, { exps });
      return this.mk('let', t, { decs, body });
    }
    if (this.isOp(t, '(')) {
      this.take();
      if (this.acceptOp(')')) return this.mk('tuple', t, { items: [] });
      const first = this.parseExp();
      if (this.atOp(',')) {
        const items = [first];
        while (this.acceptOp(',')) items.push(this.parseExp());
        this.expectOp(')');
        return this.mk('tuple', t, { items });
      }
      if (this.atOp(';')) {
        const exps = [first];
        while (this.acceptOp(';')) exps.push(this.parseExp());
        this.expectOp(')');
        return this.mk('seq', t, { exps });
      }
      this.expectOp(')');
      // keep the parenthesised expression's own node; widen its loc to include the parentheses
      first.loc = { line: t.line, col: t.col, start: t.start, end: this.prevEnd };
      return first;
    }
    return this.unexpected(t, 'an expression');
  }

  parseMatch() {
    const rules = [];
    do {
      const pat = this.parsePat();
      this.expectOp('=>');
      rules.push({ pat, exp: this.parseExp() });
    } while (this.acceptOp('|'));
    return rules;
  }

  // ---- patterns -----------------------------------------------------------------------------------

  startsAtpat(t) {
    if (t.type === 'int' || t.type === 'id' || t.type === 'string' || t.type === 'char') return true;
    return t.type === 'op' && (t.value === '_' || t.value === '(' || t.value === '[');
  }

  parsePat() {
    const from = this.peek();
    let p = this.parseConsPat();
    while (this.atOp(':')) {
      this.take();
      p = this.mk('ptyped', from, { pat: p, ty: this.parseType() });
    }
    return p;
  }

  // pat :: pat (right associative), over constructor applications and atomic patterns
  parseConsPat() {
    const from = this.peek();
    let p;
    // longcon atpat: an identifier applied to a pattern. Whether it is a constructor is decided by the checker.
    if (from.type === 'id' && this.startsAtpat(this.peek(1))) {
      this.take();
      const con = this.mk('pid', from, { name: from.value, qual: from.qual });
      const arg = this.parseAtpat();
      p = this.mk('pcon', from, { con, arg });
    } else {
      p = this.parseAtpat();
    }
    const nx = this.peek();
    if (nx.type === 'sym' && nx.value === '::') {
      this.take();
      const rest = this.parseConsPat();
      const con = { kind: 'pid', name: '::', qual: null, basis: true, loc: { line: nx.line, col: nx.col, start: nx.start, end: nx.end } };
      p = this.mk('pcon', from, { con, arg: this.mk('ptuple', from, { items: [p, rest] }) });
    }
    return p;
  }

  parseAtpat() {
    const t = this.peek();
    if (this.isOp(t, '_')) { this.take(); return this.mk('wild', t, {}); }
    if (t.type === 'int') { this.take(); return this.mk('pint', t, { value: t.value }); }
    if (t.type === 'string') { this.take(); return this.mk('pstring', t, { value: t.value }); }
    if (t.type === 'char') { this.take(); return this.mk('pchar', t, { value: t.value }); }
    if (this.isOp(t, '[')) {
      this.take();
      const items = [];
      if (!this.acceptOp(']')) {
        do items.push(this.parsePat()); while (this.acceptOp(','));
        this.expectOp(']', "',' or ']'");
      }
      return this.mk('plist', t, { items });
    }
    if (t.type === 'id') { this.take(); return this.mk('pid', t, { name: t.value, qual: t.qual }); }
    if (this.isOp(t, '(')) {
      this.take();
      if (this.acceptOp(')')) return this.mk('ptuple', t, { items: [] });
      const first = this.parsePat();
      if (this.atOp(',')) {
        const items = [first];
        while (this.acceptOp(',')) items.push(this.parsePat());
        this.expectOp(')');
        return this.mk('ptuple', t, { items });
      }
      this.expectOp(')');
      first.loc = { line: t.line, col: t.col, start: t.start, end: this.prevEnd };
      return first;
    }
    return this.unexpected(t, 'a pattern');
  }

  // ---- types --------------------------------------------------------------------------------------

  parseType() {
    const from = this.peek();
    const left = this.parseTupleType();
    if (this.acceptOp('->')) return this.mk('arrow', from, { from: left, to: this.parseType() });
    return left;
  }

  parseTupleType() {
    const from = this.peek();
    const first = this.parseTyApp();
    if (!(this.peek().type === 'sym' && this.peek().value === '*')) return first;
    const items = [first];
    while (this.peek().type === 'sym' && this.peek().value === '*') {
      this.take();
      items.push(this.parseTyApp());
    }
    return this.mk('ttuple', from, { items });
  }

  parseTyApp() {
    const from = this.peek();
    let ty = this.parseAtTy();
    while (this.peek().type === 'id') {
      const c = this.take();
      ty = this.mk('tycon', from, { name: c.value, qual: c.qual, args: [ty] });
    }
    return ty;
  }

  parseAtTy() {
    const t = this.peek();
    if (t.type === 'tyvar') { this.take(); return this.mk('tyvar', t, { name: t.value, eq: !!t.eq }); }
    if (t.type === 'id') { this.take(); return this.mk('tycon', t, { name: t.value, qual: t.qual, args: [] }); }
    if (this.isOp(t, '(')) {
      this.take();
      const tys = [this.parseType()];
      while (this.acceptOp(',')) tys.push(this.parseType());
      this.expectOp(')');
      if (tys.length === 1) {
        tys[0].loc = { line: t.line, col: t.col, start: t.start, end: this.prevEnd };
        return tys[0];
      }
      const c = this.peek();
      if (c.type !== 'id') this.unexpected(c, 'a type name after the parenthesised types');
      this.take();
      return this.mk('tycon', t, { name: c.value, qual: c.qual, args: tys });
    }
    return this.unexpected(t, 'a type');
  }
}

export function parse(source) {
  return new Parser(source).parseAll();
}
