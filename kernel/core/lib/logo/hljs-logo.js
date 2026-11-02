// highlight.js grammar for Logo cells (Berkeley Logo syntax, LOGO.md 4.1 and 7.5). highlight.js ships no Logo grammar, so this
// one is written here. CommonJS so both the browser bundle (scripts/build-postcard-libs.js) and the server
// (IdentityServer.js) can register it, the same as core/lib/ml/hljs-ml.js.
//
//   ;# instant               meta      a pragma line (LOGO.md 7.6), which would otherwise read as a comment
//   ; text                   comment
//   "word                    string    a quoted word: ends at a space, bracket or parenthesis
//   :name                    variable
//   TO name :in ... END      keyword   (TO and END only; the procedure name after TO is coloured as a title)
//   FD REPEAT IF ...        built_in  the commonly used primitives; any other word is plain text
//   3  3.5  .5  1e-3         number
//   [ ] { } ( )              punctuation
//   + - * / = < > <= >= <>   operator
//
// Names are case-insensitive in Logo, so the grammar is too. The primitive list is deliberately short: it only has to
// colour what a reader expects to see coloured, and a name missing from it just renders as plain text. It is not the
// engine's primitive table (LOGO.md 4.2) and nothing reads it for meaning.

const KEYWORDS = 'to end';

// Primitive and library-procedure names that appear in almost every Logo program (turtle, control, words and lists,
// variables, arithmetic, predicates). Each name here is in the Berkeley Logo manual (LOGO.md 4.2).
const BUILT_INS = [
  // turtle and pen
  'forward fd back bk left lt right rt setpos setxy setx sety setheading seth home arc pos xcor ycor heading towards',
  'showturtle st hideturtle ht clean clearscreen cs wrap window fence fill filled label setscrunch',
  'pendown pd penup pu penpaint ppt penerase pe penreverse px setpencolor setpc setpalette setpensize setbackground setbg',
  'pendownp pencolor pc pensize background bg',
  // control
  'run repeat forever if ifelse test iftrue ift iffalse iff stop output op catch throw error pause continue wait bye',
  'apply invoke foreach map filter find reduce cascade crossmap for while until do.while do.until case cond ignore',
  'goto tag',
  // words, lists, arrays
  'word list sentence se fput lput array listtoarray arraytolist combine reverse gensym',
  'first firsts last butfirst bf butfirsts bfs butlast bl item pick remove remdup count member',
  'setitem push pop queue dequeue',
  'wordp listp arrayp emptyp equalp notequalp beforep memberp substringp numberp',
  'ascii char lowercase uppercase parse runparse',
  // variables and definition
  'make name local localmake thing global pprop gprop remprop plist',
  'define text fulltext copydef print pr show type',
  'readlist rl readword rw readchar rc',
  // arithmetic
  'sum difference minus product quotient remainder modulo int round sqrt power exp ln log10',
  'sin cos arctan radsin radcos radarctan random rerandom iseq rseq and or not',
].join(' ').split(' ');

module.exports = function hljsLogo(hljs) {
  return {
    name: 'Logo (Berkeley Logo)',
    aliases: ['ucblogo'],
    case_insensitive: true,
    keywords: {
      $pattern: /[A-Za-z_.?][A-Za-z0-9_.?]*/,
      keyword: KEYWORDS,
      built_in: BUILT_INS.join(' '),
      literal: 'true false',
    },
    contains: [
      // A pragma must come before the comment mode: both start at `;`, and the first mode listed wins.
      { className: 'meta', begin: /;#/, end: /$/ },
      hljs.COMMENT(';', '$'),
      // `to name :a :b`: colour the procedure name. relevance 0 keeps auto-detection from preferring this grammar.
      { begin: [/\bto/, /\s+/, /[^\s\[\]{}()]+/], beginScope: { 1: 'keyword', 3: 'title.function' } },
      // A quoted word ("name, "3, "|a b|). The `|...|` form may contain spaces.
      { className: 'string', begin: /"\|/, end: /\|/ },
      { className: 'string', begin: /"[^\s\[\]{}()]*/ },
      // :name  (the dots form of THING)
      { className: 'variable', begin: /:[^\s\[\]{}()+\-*\/=<>]+/ },
      { className: 'number', begin: /(?:\b\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/, relevance: 0 },
      { className: 'operator', begin: /<=|>=|<>|[+\-*\/=<>]/, relevance: 0 },
      { className: 'punctuation', begin: /[\[\]{}()]/, relevance: 0 },
    ],
  };
};
