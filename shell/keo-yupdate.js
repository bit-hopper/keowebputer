// A small reader for the bytes of a Yjs update (the "v1" format): it says which structs the update brings (whose client id, which clock
// range) and which ranges it deletes, and nothing else. No Yjs, no storage, no DOM.
//
// WHY IT EXISTS. keo-wikilog.js accepts a wiki edit only if every struct in it carries a client id that belongs to the edit's author
// (an edit that reuses another person's client id splits the pages of everyone who receives it, for good: tested). That check has to
// read hostile bytes. It reads them TWICE, with this file and with Yjs's own decoder (keo-yjs.js), and refuses the edit unless the two
// agree on every struct and every deleted range (`sameAs` below), so that no crafted update can show this reader one set of ids and
// Yjs another. The reader is deliberately STRICTER than Yjs where Yjs is loose, because a refusal is always safe and a disagreement is
// not: it refuses bytes after the end of the update, a number above 2^53-1 (Yjs lets a long number lose precision, so two different
// byte strings can name the same id), a read past the end of the bytes, and nesting deeper than MAX_DEPTH.
//
// It follows the decoder behind Y.decodeUpdate (utils/updates.js, lazyStructReaderGenerator) and the content readers of Yjs 13.6.31
// (structs/Content*.js, lib0 decoding.js). Where those read the same bytes differently, this follows decodeUpdate and the check
// refuses; the one case found by reading is an "info" byte whose low five bits are 10 (a Skip) with a flag bit also set: the reader
// that applies an update treats it as a Skip, decodeUpdate throws, so such an update is refused.
//
// Never use it to APPLY or to understand an update's content: it skips contents, it does not interpret them.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.keoYUpdate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_SAFE = Number.MAX_SAFE_INTEGER, MAX_DEPTH = 100;
  // the same decoder lib0 uses for strings: invalid UTF-8 is an error, a leading byte-order mark is kept
  var utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  function Reader(bytes) { this.a = bytes; this.p = 0; }
  Reader.prototype.byte = function () {
    if (this.p >= this.a.length) throw new Error('keoYUpdate: unexpected end');
    return this.a[this.p++];
  };
  // lib0 readVarUint: seven bits at a time, low first; the top bit says another byte follows
  Reader.prototype.varUint = function () {
    var num = 0, mult = 1;
    for (;;) {
      var r = this.byte();
      num += (r & 127) * mult; mult *= 128;
      if (num > MAX_SAFE) throw new Error('keoYUpdate: number above 2^53-1');
      if (r < 128) return num;
    }
  };
  // lib0 readVarInt: the first byte holds six bits and the sign
  Reader.prototype.varInt = function () {
    var r = this.byte(), num = r & 63, mult = 64;
    if ((r & 128) === 0) return num;
    for (;;) {
      r = this.byte();
      num += (r & 127) * mult; mult *= 128;
      if (num > MAX_SAFE) throw new Error('keoYUpdate: number above 2^53-1');
      if (r < 128) return num;
    }
  };
  Reader.prototype.skip = function (n) {
    if (n > this.a.length - this.p) throw new Error('keoYUpdate: unexpected end');
    this.p += n;
  };
  Reader.prototype.varBytes = function () {
    var n = this.varUint(), at = this.p;
    this.skip(n);
    return this.a.subarray(at, at + n);
  };
  Reader.prototype.varString = function () { return utf8.decode(this.varBytes()); };
  Reader.prototype.json = function () { return JSON.parse(this.varString()); };
  // lib0 readAny: a tag byte (127 down to 116) and its value
  Reader.prototype.any = function (depth) {
    if (depth > MAX_DEPTH) throw new Error('keoYUpdate: nested too deep');
    var tag = this.byte(), n, i;
    switch (tag) {
      case 127: case 126: case 121: case 120: return;
      case 125: this.varInt(); return;
      case 124: this.skip(4); return;
      case 123: case 122: this.skip(8); return;
      case 119: this.varString(); return;
      case 118: n = this.varUint(); for (i = 0; i < n; i++) { this.varString(); this.any(depth + 1); } return;
      case 117: n = this.varUint(); for (i = 0; i < n; i++) this.any(depth + 1); return;
      case 116: this.varBytes(); return;
      default: throw new Error('keoYUpdate: unknown value tag');
    }
  };

  // What the contents are, by the low five bits of the info byte (Yjs contentRefs). Returns the struct's length in clock units.
  var CONTENT = { DELETED: 1, JSON: 2, BINARY: 3, STRING: 4, EMBED: 5, FORMAT: 6, TYPE: 7, ANY: 8, DOC: 9 };
  function content(r, ref) {
    var n, i, s;
    switch (ref) {
      case 1: return r.varUint();                                           // deleted: its length
      case 2: n = r.varUint(); for (i = 0; i < n; i++) { s = r.varString(); if (s !== 'undefined') JSON.parse(s); } return n;
      case 3: r.varBytes(); return 1;
      case 4: return r.varString().length;                                  // clock units are UTF-16 code units, as in JavaScript
      case 5: r.json(); return 1;
      case 6: r.varString(); r.json(); return 1;
      case 7: n = r.varUint();                                              // a type: its kind, and for two kinds a name
        if (n > 6) throw new Error('keoYUpdate: unknown type');
        if (n === 3 || n === 5) r.varString();
        return 1;
      case 8: n = r.varUint(); for (i = 0; i < n; i++) r.any(0); return n;
      case 9: r.varString(); r.any(0); return 1;                            // a sub-document: its id and options
      default: throw new Error('keoYUpdate: unknown content');             // 10 (a Skip) and 11 to 31 are not contents
    }
  }

  // bytes -> { structs: [ { client, clock, length, kind: 'item' | 'gc' | 'skip', ref, section } ], deletes: { client: [ [clock, length], ... ] } }
  // `section` counts the client sections of the update: Yjs decodes a client that has two sections as both but APPLIES only the last
  // (its map is overwritten), so a caller that cares must refuse an update where one client has structs in two sections.
  // Throws on anything it does not understand, and on bytes left over at the end. `bytes` should be a Uint8Array that owns its buffer:
  // Yjs reads a byte string straight out of the underlying buffer, so on a view it can read past the end of the view (tested: it then
  // fails one read later), and both readers must be given the same bytes and nothing around them.
  function readUpdate(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error('keoYUpdate: not bytes');
    var r = new Reader(bytes), structs = [], nClients = r.varUint(), c, k, client, clock, nStructs;
    for (c = 0; c < nClients; c++) {
      nStructs = r.varUint(); client = r.varUint(); clock = r.varUint();
      for (k = 0; k < nStructs; k++) {
        var info = r.byte(), st = { client: client, clock: clock, length: 0, kind: 'item', ref: undefined, section: c };
        if (info === 10) { st.kind = 'skip'; st.length = r.varUint(); }
        else if ((info & 31) !== 0) {
          var cantCopyParent = (info & 192) === 0;
          if (info & 128) { r.varUint(); r.varUint(); }                     // the item it was put after (a client id and a clock)
          if (info & 64) { r.varUint(); r.varUint(); }                      // the item it was put before
          if (cantCopyParent) {
            if (r.varUint() === 1) r.varString(); else { r.varUint(); r.varUint(); }   // its parent: a named root type, or an item
            if (info & 32) r.varString();                                   // the key it has in a map
          }
          st.ref = info & 31;
          st.length = content(r, st.ref);
        } else { st.kind = 'gc'; st.length = r.varUint(); }
        clock += st.length;
        if (clock > MAX_SAFE) throw new Error('keoYUpdate: clock above 2^53-1');
        structs.push(st);
      }
    }
    var deletes = {}, nDs = r.varUint(), d, nDel, j, cl;
    for (d = 0; d < nDs; d++) {
      cl = r.varUint(); nDel = r.varUint();
      if (nDel > 0) {
        if (!deletes[cl]) deletes[cl] = [];
        for (j = 0; j < nDel; j++) { var ck = r.varUint(), len = r.varUint(); deletes[cl].push([ck, len]); }
      }
    }
    if (r.p !== bytes.length) throw new Error('keoYUpdate: bytes after the end of the update');
    return { structs: structs, deletes: deletes };
  }

  // Does what this reader found equal what Yjs's own Y.decodeUpdate found? `Y` is the Yjs library, `decoded` is Y.decodeUpdate's
  // result for the SAME bytes. Resolves to null when they agree on every struct (client, clock, length, kind) and every deleted range
  // (per client, in the order read), else to a sentence saying where they differ.
  function sameAs(mine, decoded, Y) {
    if (!decoded || !Array.isArray(decoded.structs) || !decoded.ds || !(decoded.ds.clients instanceof Map)) return 'Yjs gave no list of structs';
    if (mine.structs.length !== decoded.structs.length) return 'the two readers found ' + mine.structs.length + ' and ' + decoded.structs.length + ' structs';
    for (var i = 0; i < mine.structs.length; i++) {
      var a = mine.structs[i], b = decoded.structs[i];
      var kind = b instanceof Y.Item ? 'item' : b instanceof Y.GC ? 'gc' : b instanceof Y.Skip ? 'skip' : '?';
      if (!b.id || a.client !== b.id.client || a.clock !== b.id.clock || a.length !== b.length || a.kind !== kind) return 'the two readers differ at struct ' + i;
    }
    var mineClients = Object.keys(mine.deletes), theirs = Array.from(decoded.ds.clients.keys());
    if (mineClients.length !== theirs.length) return 'the two readers found different deleted ranges';
    for (var c = 0; c < theirs.length; c++) {
      var mineRanges = mine.deletes[theirs[c]], their = decoded.ds.clients.get(theirs[c]);
      if (!mineRanges || mineRanges.length !== their.length) return 'the two readers found different deleted ranges';
      for (var j = 0; j < their.length; j++) if (mineRanges[j][0] !== their[j].clock || mineRanges[j][1] !== their[j].len) return 'the two readers found different deleted ranges';
    }
    return null;
  }

  return { readUpdate: readUpdate, sameAs: sameAs, CONTENT: CONTENT, MAX_SAFE: MAX_SAFE };
});
