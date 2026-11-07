// The text a person carries from one device to another when an identity is added to a second device (keo-identity.js enrollRequest /
// enrollGrant / enrollComplete). Pure functions: no storage, no DOM, no keys. Loaded as a plain script in the shell page
// (window.keoEnrollCode) and require()d from Node tests.
//
// Three kinds, one per message: a REQUEST (the new device, public keys only), a GRANT (the old device: the identity's log and the account
// secret sealed to the request's key) and a DONE (the finished log, for the old device to keep). Each is "<kind>." then the message as
// base64url JSON, so it survives a copy and paste, a chat message, an e-mail or a file, which is the point: nothing about how it gets
// there is trusted. None of the three is a secret by itself. A request and a done hold public data. A grant holds the account secret, but
// sealed so that only the device that made the request can open it. What keeps a stranger from putting THEIR request in front of the old
// device is the eight words the person compares (keo-fingerprint.js requestWords), not the code.
// A code is checked for its kind and its size here and nowhere else; whether its CONTENT is good is the identity module's business.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.keoEnrollCode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var KINDS = { request: 'keo-enroll-request.', grant: 'keo-enroll-grant.', done: 'keo-enroll-done.' };
  var NAMES = { request: 'a request code', grant: 'a reply code', done: 'a finished code' };
  // A grant holds a whole log; 64 KB of text is far more than any real one and keeps a pasted novel out of the parser.
  var MAX_CHARS = 65536;

  function b64u(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(str) {
    var t = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    var bin = atob(t), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function encode(kind, message) {
    if (!KINDS[kind]) throw new Error('keoEnrollCode: unknown kind ' + kind);
    return KINDS[kind] + b64u(new TextEncoder().encode(JSON.stringify(message)));
  }

  // Which kind a piece of text claims to be, or null. Whitespace anywhere (a wrapped line, a trailing newline) is ignored.
  function kindOf(text) {
    var t = String(text == null ? '' : text).replace(/\s+/g, '');
    for (var k in KINDS) if (t.indexOf(KINDS[k]) === 0) return k;
    return null;
  }

  // The message inside, or an Error whose text can be shown to the person as it stands.
  function decode(kind, text) {
    if (!KINDS[kind]) throw new Error('keoEnrollCode: unknown kind ' + kind);
    var t = String(text == null ? '' : text).replace(/\s+/g, '');
    if (!t) throw new Error('Nothing was pasted.');
    if (t.length > MAX_CHARS) throw new Error('That is too long to be a code.');
    var got = kindOf(t);
    if (!got) throw new Error('That is not a valid code.');
    if (got !== kind) throw new Error('That is ' + NAMES[got] + '. ' + cap(NAMES[kind]) + ' is needed here.');
    var body = t.slice(KINDS[kind].length), obj;
    if (!/^[A-Za-z0-9_-]+$/.test(body)) throw new Error('That is not a valid code.');
    try { obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(unb64u(body))); }
    catch (e) { throw new Error('That is not a valid code. It may have been cut short when it was copied.'); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('That is not a valid code.');
    return obj;
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  return { KINDS: KINDS, MAX_CHARS: MAX_CHARS, encode: encode, decode: decode, kindOf: kindOf };
});
