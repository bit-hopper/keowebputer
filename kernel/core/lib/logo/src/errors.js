// Logo errors (LOGO.md 5.5). Wording and numbering follow the reference's error table (decision 4), written out here
// as our own table rather than copied as a data file (decision 10). Note the TWO spaces in "I don't know how  to":
// the reference prints them and CSLS transcripts show them (11.5 item 3).
//
// A LogoError is also the payload of THROW "ERROR: `catch "error [...]` catches it and `error` outputs
// [code message procname line]. The procname / line fields are filled in by the machine at the moment the error is
// raised (it alone knows the running procedure and line); primitives only supply code, message and culprit.

export class LogoError extends Error {
  constructor(code, message, culprit) {
    super(message);
    this.code = code;
    this.culprit = culprit;    // the offending value or name, if any (kept for tools; not printed separately)
    this.proc = null;          // name of the user-defined procedure running when it was raised, else null
    this.line = null;          // that procedure's current body line, as a list, else null
    this.located = false;      // true when proc / line were set deliberately (THROW "ERROR message) and must not be overwritten
    this.userThrown = false;   // true for (THROW "ERROR [message]) / ERROR codes the program made up
  }
}

// Codes that tests and callers refer to by name.
export const CODE = {
  STACK_OVERFLOW: 2,
  OUT_OF_BOUNDS: 3,     // a fenced turtle was asked to leave the window
  BAD_VALUE: 4,        // a value of the right type but out of range ("item doesn't like 0 as input", "/ doesn't like 0")
  NOT_OUTPUT: 5,
  TOO_FEW: 6,
  BAD_TYPE: 7,         // a value of the wrong type ("first doesn't like [] as input")
  TOO_MANY: 8,
  NO_PLAN: 9,          // You don't say what to do with X
  NO_VALUE: 11,
  UNEXPECTED_CLOSE_PAREN: 12,
  UNKNOWN_PROC: 13,
  NO_CATCH: 14,
  ALREADY_DEFINED: 15,
  IS_PRIMITIVE: 22,
  TO_INSIDE: 23,
  NO_TEST: 25,
  UNEXPECTED_CLOSE_BRACKET: 26,
  UNEXPECTED_CLOSE_BRACE: 27,
  MACRO_RETURNED: 29,
  ONLY_IN_PROC: 31,
  APPLY_BAD: 32,
  USER: 35,
  BAD_DEFAULT: 37,
  NO_OUTPUT_IN_RUNRESULT: 38,
};

// Constructors for each error the machine and primitives raise. `shown` arguments are already-formatted text (the
// caller passes the show-form of a value, via printer.js showForm).
export const err = {
  badType: (proc, shown) => new LogoError(CODE.BAD_TYPE, `${proc} doesn't like ${shown} as input`, shown),
  badValue: (proc, shown) => new LogoError(CODE.BAD_VALUE, `${proc} doesn't like ${shown} as input`, shown),
  notOutput: (proc, consumer) => new LogoError(CODE.NOT_OUTPUT, `${proc} didn't output to ${consumer}`, proc),
  tooFew: (proc) => new LogoError(CODE.TOO_FEW, `not enough inputs to ${proc}`, proc),
  tooMany: (proc) => new LogoError(CODE.TOO_MANY, `too many inputs to ${proc}`, proc),
  noPlan: (shown) => new LogoError(CODE.NO_PLAN, `You don't say what to do with ${shown}`, shown),
  noValue: (name) => new LogoError(CODE.NO_VALUE, `${name} has no value`, name),
  closeParen: () => new LogoError(CODE.UNEXPECTED_CLOSE_PAREN, "unexpected ')'"),
  closeBracket: () => new LogoError(CODE.UNEXPECTED_CLOSE_BRACKET, "unexpected ']'"),
  closeBrace: () => new LogoError(CODE.UNEXPECTED_CLOSE_BRACE, "unexpected '}'"),
  unknownProc: (name) => new LogoError(CODE.UNKNOWN_PROC, `I don't know how  to ${name}`, name),
  noCatch: (tag) => new LogoError(CODE.NO_CATCH, `Can't find catch tag for ${tag}`, tag),
  alreadyDefined: (name) => new LogoError(CODE.ALREADY_DEFINED, `${name} is already defined`, name),
  isPrimitive: (name) => new LogoError(CODE.IS_PRIMITIVE, `${name} is a primitive`, name),
  toInside: () => new LogoError(CODE.TO_INSIDE, "Can't use TO inside a procedure"),
  noTest: (what) => new LogoError(CODE.NO_TEST, `${what} without TEST`, what),
  macroReturned: (shown) => new LogoError(CODE.MACRO_RETURNED, `Macro returned ${shown} instead of a list`, shown),
  onlyInProc: (what) => new LogoError(CODE.ONLY_IN_PROC, `Can only use ${what} inside a procedure`, what),
  applyBad: (shown) => new LogoError(CODE.APPLY_BAD, `APPLY doesn't like ${shown} as input`, shown),
  outOfBounds: () => new LogoError(CODE.OUT_OF_BOUNDS, 'turtle out of bounds'),
  // The reference reports FILLED inside FILLED as "couldn't initialize graphics" (code 28); this says what is wrong.
  nestedFilled: () => new LogoError(28, "FILLED can't be used inside FILLED"),
  stackOverflow: () => new LogoError(CODE.STACK_OVERFLOW, 'stack overflow'),
  badDefault: (shown) => new LogoError(CODE.BAD_DEFAULT, `Bad default expression for optional input: ${shown}`, shown),
  user: (text) => { const e = new LogoError(CODE.USER, text); e.userThrown = true; return e; },
};
