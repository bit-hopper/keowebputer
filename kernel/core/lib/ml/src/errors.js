// The engine's error type. `errorClass` is one of the classes of MLspec.md section 6.6:
//   ungrammatical  the book's ⊗: not a legal form at all
//   syntax         any other parse failure
//   nonsense       no type
//   redundant      a match rule no value can reach (SML/NJ rejects it too; demotable to a warning by a page setting)
//   signature      signature nonsense / module mismatch
//   exception      meaningless: an exception reached the top
//   limit          meaningless: ran out of room (stack depth, Stop)
//   internal       a bug
// `line`/`col` are 1-based; `start`/`end` are offsets into the source being processed.

export class MLError extends Error {
  constructor(errorClass, message, where) {
    super(message);
    this.name = 'MLError';
    this.errorClass = errorClass;
    this.line = where ? where.line : null;
    this.col = where ? where.col : null;
    this.start = where && where.start !== undefined ? where.start : null;
    this.end = where && where.end !== undefined ? where.end : null;
  }
}

// `where` is anything with line/col (a token or an AST node's loc).
export const syntaxError = (message, where) => new MLError('syntax', message, where);
export const ungrammatical = (message, where) => new MLError('ungrammatical', message, where);
