// Number syntax and number printing for the Logo engine (LOGO.md decision 11 and 11.5 item 2).
//
// Logo has no separate integer type that matters to a program: every number is a JS double, integers are exact up to
// 2^53 and larger ones simply become floats (which is also what the reference interpreter prints). What does matter is
// how a number is PRINTED: the reference uses C's printf("%.15g"), which `Number#toString` does not match (it prints
// 1e+22 as "1e+22" but 0.000001 as "0.000001" where C prints "1e-06", and it keeps up to 17 digits where C stops at 15).

// A word that "looks like a number" is a number to arithmetic and to NUMBERP (LOGO.md 4.1). The reference accepts an
// optional leading minus, digits with an optional point on either side (".5", "5."), and an optional exponent.
// No leading plus: "+" is an infix operator character and cannot start a number token.
const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

// True when the text is a number token. Call this on word TEXT; for a value that may already be a JS number or a
// non-word, use data.js numberValue(). Does not trim: " 3" is not a number.
export function isNumberText(text) {
  return NUMBER_RE.test(text);
}

// The JS number for a number token, or null if the text is not one. Never returns NaN.
export function parseNumber(text) {
  if (!NUMBER_RE.test(text)) return null;
  const n = Number(text);   // Number("5.") === 5 and Number(".5") === 0.5, so the reference's forms parse as-is
  return Number.isFinite(n) ? n : null;
}

// Prints a number the way C's printf("%.15g") does: 15 significant digits, trailing zeros removed, no trailing ".0",
// exponent form (at least two exponent digits) when the decimal exponent is below -4 or at least 15.
//   formatNumber(0.1 + 0.2) === "0.3"         formatNumber(1e22) === "1e+22"        formatNumber(3.14e-5) === "3.14e-05"
//   formatNumber(123456789000) === "123456789000"      formatNumber(1 / 3) === "0.333333333333333"
// NaN prints as "-nan" (that is what the reference prints for sqrt -1; it does not raise an error, 11.5 item 2) and the
// infinities as "inf" / "-inf". Negative zero prints as "0": the reference prints 0 for `minus 0` and for `0 * -1`.
// Do not use String(n) or n.toPrecision(15) for printing a Logo number; both differ from this in the cases above.
export function formatNumber(x) {
  if (x !== x) return '-nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return '0';
  // toExponential(14) rounds to 15 significant digits: "d.dddddddddddddde+X". Parsing that string (rather than doing
  // the rounding ourselves) gives the correctly rounded digits and the post-rounding exponent in one step.
  const m = /^(-?)(\d)\.?(\d*)e([+-]\d+)$/.exec(x.toExponential(14));
  const sign = m[1];
  let digits = (m[2] + m[3]).replace(/0+$/, '');   // significant digits, trailing zeros dropped (at least "d" remains)
  if (digits === '') digits = '0';
  const exp = parseInt(m[4], 10);
  if (exp < -4 || exp >= 15) {
    const mant = digits.length > 1 ? digits[0] + '.' + digits.slice(1) : digits;
    const ae = Math.abs(exp);
    return sign + mant + 'e' + (exp < 0 ? '-' : '+') + (ae < 10 ? '0' + ae : String(ae));
  }
  if (exp >= 0) {
    // Positional with the point after exp+1 digits; pad with zeros when the digits run out first (e.g. 1e10).
    if (digits.length <= exp + 1) return sign + digits + '0'.repeat(exp + 1 - digits.length);
    return sign + digits.slice(0, exp + 1) + '.' + digits.slice(exp + 1);
  }
  return sign + '0.' + '0'.repeat(-exp - 1) + digits;
}
