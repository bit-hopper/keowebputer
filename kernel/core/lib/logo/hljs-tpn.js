// highlight.js grammar for Turtle Procedure Notation cells (LOGO.md 4.3, 7.5). CommonJS so both the browser bundle
// (scripts/build-postcard-libs.js) and the server (IdentityServer.js) can register it.
//
//   ;# instant               meta      a pragma line, which would otherwise read as a comment
//   ; text                   comment
//   "text"                   string    TPN strings are quoted at both ends
//   TO NAME a b              keyword   a procedure title line (the name after TO is coloured as a title)
//   IF THEN ELSE REPEAT ...  keyword
//   RETURN STOP              keyword
//   <-  ←                    keyword   assignment; the typed ASCII form `<-` is accepted (LOGO.md 7.5)
//   ^                        operator  exponentiation
//   3  3.45                  number
//
// The cell stores what was typed; `<-` is only coloured as the assignment arrow here. Showing it as the glyph `←` in the
// highlighted view is the editor's job, not the grammar's, and is not part of Phase 0.
//
// Variables are bare names in TPN, so unlike Logo there is no variable colouring: whether a bare name is a variable or a
// procedure call is decided by the engine's static pass (LOGO.md 4.3), which a highlighter cannot reproduce.

const KEYWORDS = [
  'to', 'if', 'then', 'else', 'repeat', 'forever', 'until', 'for', 'in', 'return', 'stop', 'execute',
  'both', 'either', 'not',
].join(' ');

// The turtle commands the book names in Appendix A (LOGO.md 4.3, last row).
const BUILT_INS = [
  'forward back left right penup pendown setxy setheading xcor ycor heading', 'turtle.state setturtle',
  'hideturtle showturtle clearscreen drawline eraseline',
  'rand sin cos arctan sqrt remainder abs int', 'item first rest print',
].join(' ');

module.exports = function hljsTpn(hljs) {
  return {
    name: 'Turtle Procedure Notation',
    aliases: [],
    case_insensitive: true,
    keywords: {
      $pattern: /[A-Za-z_][A-Za-z0-9_.]*/,
      keyword: KEYWORDS,
      built_in: BUILT_INS,
      literal: 'true false',
    },
    contains: [
      // A pragma must come before the comment mode: both start at `;`, and the first mode listed wins.
      { className: 'meta', begin: /;#/, end: /$/ },
      hljs.COMMENT(';', '$'),
      { begin: [/\bto/, /\s+/, /[A-Za-z_][A-Za-z0-9_.]*/], beginScope: { 1: 'keyword', 3: 'title.function' } },
      { className: 'string', begin: /"/, end: /"/, contains: [{ begin: /\\./ }] },
      { className: 'keyword', begin: /<-|←/ },
      { className: 'number', begin: /\b\d+\.?\d*(?:[eE][+-]?\d+)?/, relevance: 0 },
      { className: 'operator', begin: /<=|>=|[+\-*\/=<>^]/, relevance: 0 },
      { className: 'punctuation', begin: /[\[\](),]/, relevance: 0 },
    ],
  };
};
