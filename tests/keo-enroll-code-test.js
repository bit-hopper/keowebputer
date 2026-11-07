// Node test for keo-enroll-code.js (the text carried between two devices when an identity is added to another): no browser.
// Usage: node keo-enroll-code-test.js
const path = require('path');
const code = require(path.join(__dirname, '..', 'shell', 'keo-enroll-code.js'));
let passed = 0;
const ok = (name, cond, extra) => { if (!cond) { console.error('FAIL ' + name + (extra ? ' ' + JSON.stringify(extra) : '')); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } };
const err = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const msg = { v: 1, kind: 'enroll-request', note: 'café ☃ 😀', n: [1, 2, 3], nested: { a: 'b' } };
for (const kind of ['request', 'grant', 'done']) {
  const text = code.encode(kind, msg);
  ok(kind + ': round trip keeps the message, including non-ASCII text', JSON.stringify(code.decode(kind, text)) === JSON.stringify(msg));
  ok(kind + ': starts with its own label and is one line of URL-safe characters', text.startsWith(code.KINDS[kind]) && /^[A-Za-z0-9_.-]+$/.test(text));
  ok(kind + ': kindOf names it', code.kindOf(text) === kind);
}
const req = code.encode('request', msg);
ok('line breaks, spaces and tabs inside the code do not matter (it was wrapped or indented when copied)', JSON.stringify(code.decode('request', '  ' + req.slice(0, 20) + '\r\n' + req.slice(20, 60) + ' \t' + req.slice(60) + '\n')) === JSON.stringify(msg));
ok('a code of the wrong kind says what it is and what is needed', /That is a request code\. A reply code is needed here\./.test(err(() => code.decode('grant', req))));
ok('and the other kinds', /That is a reply code\. A finished code is needed here\./.test(err(() => code.decode('done', code.encode('grant', msg)))) && /a request code is needed|A request code is needed/.test(err(() => code.decode('request', code.encode('done', msg)))));
ok('empty, missing and non-text input say nothing was pasted or that it is not valid', /Nothing was pasted/.test(err(() => code.decode('request', ''))) && /Nothing was pasted/.test(err(() => code.decode('request', null))) && /not a valid code/.test(err(() => code.decode('request', 12345))));
ok('text with no label is not a valid code', /not a valid code/.test(err(() => code.decode('request', 'hello there'))));
ok('a label with a damaged body is not a valid code', /not a valid code/.test(err(() => code.decode('request', code.KINDS.request + '!!!!'))) && /not a valid code/.test(err(() => code.decode('request', code.KINDS.request))));
ok('a code cut short is reported as cut short, not as a crash', /cut short/.test(err(() => code.decode('request', req.slice(0, req.length - 9)))));
ok('a body that is valid base64 but not JSON is not a valid code', /not a valid code/.test(err(() => code.decode('request', code.KINDS.request + Buffer.from('not json').toString('base64url')))));
ok('JSON that is not an object (a number, a list, null) is not a valid code', ['5', '[1]', 'null', '"x"'].every((j) => /not a valid code/.test(err(() => code.decode('request', code.KINDS.request + Buffer.from(j).toString('base64url'))))));
ok('invalid UTF-8 in the body is not a valid code', /not a valid code/.test(err(() => code.decode('request', code.KINDS.request + Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url')))));
ok('too much text is refused before it is parsed', /too long/.test(err(() => code.decode('request', code.KINDS.request + 'A'.repeat(code.MAX_CHARS)))));
ok('a code of the largest size allowed still decodes', (() => { const big = { pad: 'x'.repeat(40000) }; const t = code.encode('grant', big); return t.length <= code.MAX_CHARS && code.decode('grant', t).pad.length === 40000; })());
ok('encode refuses a kind it does not know', /unknown kind/.test(err(() => code.encode('other', msg))) && /unknown kind/.test(err(() => code.decode('other', req))));
ok('kindOf is null for anything else', code.kindOf('') === null && code.kindOf(null) === null && code.kindOf('keo-enroll-requests.abc') === null);

console.log(passed + ' checks passed' + (process.exitCode ? ', SOME FAILED' : ''));
