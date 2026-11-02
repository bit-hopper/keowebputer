// highlight.js grammar for ML cells: highlight.js's own `sml` grammar plus the cell's extensions (MLspec.md 5.2, 5.9), so
// the pragma lines and the book's glyph aliases are coloured too. CommonJS so both the browser bundle
// (scripts/build-postcard-libs.js) and the server (IdentityServer.js) can register it.
//
//   (*# style: sml *)        meta     a pragma, which would otherwise read as a comment
//   •  ⊗                     meta     the type-box line marker and the "this box is rejected" prefix
//   → ⇒ ▷                    keyword  aliases of -> => :>
//   α β γ δ ε ζ η θ          symbol   aliases of 'a 'b 'c ... (type variables)
//   …                        literal  the placeholder in the book's unfinished boxes
const base = require('highlight.js/lib/languages/sml');

module.exports = function hljsMl(hljs) {
  const def = base(hljs);
  // A pragma must come before the comment mode: both start at `(*`, and the first mode listed wins.
  const extra = [
    { className: 'meta', begin: /\(\*#/, end: /\*\)/ },
    { className: 'meta', begin: /[•⊗]/ },
    { className: 'keyword', begin: /[→⇒▷]/ },
    { className: 'symbol', begin: /[αβγδεζηθ]/ },
    { className: 'literal', begin: /…/ },
  ];
  def.contains = extra.concat(def.contains);
  def.name = 'ML (Standard ML, with the book\'s notation)';
  return def;
};
