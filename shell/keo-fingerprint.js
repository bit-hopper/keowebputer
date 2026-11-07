// The words that stand for a DID when two people check that the DID is the one they mean. No storage, no DOM: pure functions over
// WebCrypto, so a Node test can check them.
//
// Why words and not the short form of a DID (keo:abcd…wxyz): that form shows 4 + 4 characters of the DID's hash, 48 bits. A
// check that backs a lasting decision ("this DID is my friend") has to hold against someone who prepares a DID that looks right
// before the codes are even swapped, and 2^48 tries is within reach of a determined attacker (an estimate, not measured here).
// Eight words are 88 bits, which is not, and they read aloud over a call, which is where the check will mostly happen. The short
// form and the picture (keo-identicon.js) stay what they are: a way to recognise a contact, never a check.
//
// How: SHA-256 over a fixed label and the whole DID string, then the first 88 bits cut into eight groups of 11 bits, each the
// index of a word in keo-wordlist.js. The label keeps the result independent of the DID's own hashing; a change to the label, the
// number of words or the list is a NEW fingerprint (bump the version in LABEL), because it would change every one ever shown.
//
// What a match says: the DID in front of you is the one the other person is reading from. It does not say who that person is;
// the call to make that out (a voice you know, a person in the room) is the person's.
(function (root, factory) {
  var kd = typeof module === 'object' && module.exports ? require('./keo-did.js') : root.keoDid;
  var wl = typeof module === 'object' && module.exports ? require('./keo-wordlist.js') : root.keoWordlist;
  var api = factory(kd, wl);
  if (typeof module === 'object' && module.exports) module.exports = api; else root.keoFingerprint = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (kd, wl) {
  'use strict';

  var subtle = globalThis.crypto && globalThis.crypto.subtle;
  var enc = new TextEncoder();
  var LABEL = 'keo/fingerprint/v1', COUNT = 8, BITS = 11;
  var WORDS = wl.WORDS;
  if (WORDS.length !== 1 << BITS) throw new Error('The word list must have exactly ' + (1 << BITS) + ' words.');
  var INDEX = {};
  WORDS.forEach(function (w, i) { INDEX[w] = i; });

  // The eight words for a DID, in order. Rejects anything that is not a well-formed DID: a fingerprint of a string that is not one
  // would look as good as any other and mean nothing.
  function cut(h) {
    var out = [], acc = 0, have = 0, p = 0;
    while (out.length < COUNT) {
      while (have < BITS) { acc = (acc << 8) | h[p++]; have += 8; }
      out.push(WORDS[(acc >> (have - BITS)) & ((1 << BITS) - 1)]);
      have -= BITS;
      acc &= (1 << have) - 1;
    }
    return out;
  }
  async function words(did) {
    if (!kd.parseDid(did)) throw new Error('That is not a keo identity.');
    return cut(new Uint8Array(await subtle.digest('SHA-256', enc.encode(LABEL + '\0' + did))));
  }

  // The same eight words for something that is not a DID: the request a new device makes to join an identity (keo-identity.js
  // enrollRequest). `text` is what both ends hash (the canonical JSON of the request). It has a label of its own, so words that
  // stand for a request can never be read as an identity's, and the other way round.
  var REQUEST_LABEL = 'keo/enroll-fingerprint/v1';
  async function requestWords(text) {
    if (typeof text !== 'string' || !text) throw new Error('keoFingerprint: a request is a non-empty string');
    return cut(new Uint8Array(await subtle.digest('SHA-256', enc.encode(REQUEST_LABEL + '\0' + text))));
  }

  // What the other person said, as typed: any case, any run of spaces, commas or line breaks between the words. Returns the
  // words as the list spells them, or null when one is not on the list (a typing slip is told apart from a mismatch).
  function parse(text) {
    var parts = String(text == null ? '' : text).toLowerCase().split(/[^a-z]+/).filter(Boolean);
    for (var i = 0; i < parts.length; i++) if (!Object.prototype.hasOwnProperty.call(INDEX, parts[i])) return null;
    return parts;
  }

  // Does what was typed or read out match this DID? Needs all eight words; fewer is not a check.
  async function matches(did, text) {
    var said = parse(text);
    if (!said || said.length !== COUNT) return false;
    var mine = await words(did);
    var diff = 0;
    for (var i = 0; i < COUNT; i++) diff |= (said[i] === mine[i]) ? 0 : 1;
    return diff === 0;
  }

  function sameWords(said, mine) {
    if (!said || said.length !== COUNT) return false;
    var diff = 0;
    for (var i = 0; i < COUNT; i++) diff |= (said[i] === mine[i]) ? 0 : 1;
    return diff === 0;
  }
  // Does what was typed or read out match this request? (requestWords)
  async function requestMatches(text, said) { return sameWords(parse(said), await requestWords(text)); }

  return { LABEL: LABEL, COUNT: COUNT, BITS: BITS, words: words, parse: parse, matches: matches, requestWords: requestWords, requestMatches: requestMatches };
});
