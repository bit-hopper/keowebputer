// Analyzed program representation executed by the machine. A single Node class
// with generic fields (rather than a class per node type) keeps property
// access monomorphic in the machine's hot loop.
//
// Field meanings by tag:
//   CONST      a=value
//   LOCAL0     a=slot index, b=name          (current frame)
//   LOCAL1     a=slot index, b=name          (parent frame)
//   LOCALN     a=depth, b=slot index, c=name
//   GLOBAL     a=Box
//   ENVREF     (evaluates to the current environment; used by LET/LETREC)
//   SETLOCAL   a=depth, b=slot index, c=value node, d=name
//   SETGLOBAL  a=Box, c=value node
//   DEFGLOBAL  a=Box, c=value node, d=symbol name (string)
//   IF         a=test, b=then, c=else
//   LAMBDA     a=LamInfo
//   SEQ        a=array of nodes
//   CALL       a=ops array (operator first), b=true if every op is "simple"
//   LET        a=ops array [ENVREF, init...], b=extra unassigned slots, c=body
//   AND / OR   a=array of nodes
//   CASE       a=key node, b=clauses [{datums, body}], c=else body or null
//   DELAY      a=body node
//   CONSSTREAM a=car node, b=cdr node (delayed)
export const T = {
  CONST: 0, LOCAL0: 1, LOCAL1: 2, LOCALN: 3, GLOBAL: 4, ENVREF: 5, // <= SIMPLE_MAX: no frames, no side effects
  SETLOCAL: 6, SETGLOBAL: 7, DEFGLOBAL: 8, IF: 9, LAMBDA: 10, SEQ: 11, CALL: 12,
  LET: 13, AND: 14, OR: 15, CASE: 16, DELAY: 17, CONSSTREAM: 18,
};
export const SIMPLE_MAX = T.ENVREF;

export class Node {
  constructor(t, a, b, c, d) { this.t = t; this.a = a; this.b = b; this.c = c; this.d = d; }
}

// Lambda metadata. `size` = number of frame slots (params + internal defines).
export class LamInfo {
  constructor(nreq, nopt, rest, size, body, name) {
    this.nreq = nreq; this.nopt = nopt; this.rest = rest; this.size = size; this.body = body; this.name = name;
  }
}
