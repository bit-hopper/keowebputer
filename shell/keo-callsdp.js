// What a session description received from the other device over the proven channel (keo-call.js) must look like before it is
// handed to the browser. Pure: no browser needed, so it is tested in node (tests/keo-callsdp-test.js).
//
// Why this exists: the channel is authenticated, and the peer's proof covers the DTLS fingerprint the first negotiation used.
// A call adds audio and video by renegotiating on that SAME connection (checked 2026-11-04 in one browser engine: it bundles the new media onto
// the one transport and every fingerprint line in the new descriptions equals the proven one). The browser would also accept a
// renegotiation that brings a second transport with another fingerprint, which the proof says nothing about, so nothing is
// trusted to the browser: a description is applied only if every fingerprint in it is the proven peer's, the media is bundled
// onto the existing transport, and the ICE credentials are unchanged. This is a check on top of the browser's, not instead.
// It is NOT a general validator of session descriptions and must not be used to judge ones from anywhere else.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.keoCallSdp = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAX_SDP = 20000, KINDS = { application: 1, audio: 1, video: 1 };

  function bad(error) { return { ok: false, error: error }; }
  function first(re, s) { var m = re.exec(s); return m ? m[1] : null; }

  // sdp: the received text. opts.peerFp: the peer's DTLS fingerprint as the proof used it (colon-separated hex, any case).
  // opts.remoteSdp: the description the connection already holds from this peer (its ICE credentials must not change).
  // Returns { ok: true, kinds: ['application', 'audio', ...] } or { ok: false, error }.
  function check(sdp, opts) {
    opts = opts || {};
    if (typeof sdp !== 'string' || !sdp.length || sdp.length > MAX_SDP) return bad('The description is missing or too large.');
    if (/\u0000/.test(sdp)) return bad('The description holds a control character.');
    var lines = sdp.split(/\r?\n/), sections = [], mids = [], groups = [], prints = [], ufrags = [], pwds = [];
    lines.forEach(function (l) {
      var m = /^m=(\S+) /.exec(l);
      if (m) sections.push(m[1]);
      if (/^a=mid:/.test(l)) mids.push(l.slice(6).trim());
      if (/^a=group:/.test(l)) groups.push(l);
      if (/^a=fingerprint:/.test(l)) prints.push(l.slice(14).trim());
      if (/^a=ice-ufrag:/.test(l)) ufrags.push(l.slice(12).trim());
      if (/^a=ice-pwd:/.test(l)) pwds.push(l.slice(10).trim());
    });
    if (!sections.length || sections.length > 3) return bad('The description has an unexpected number of media sections.');
    if (sections[0] !== 'application') return bad('The description does not start with the existing data section.');
    var seen = {};
    for (var i = 0; i < sections.length; i++) {
      if (!KINDS[sections[i]]) return bad('The description has a media section of an unknown kind.');
      if (seen[sections[i]]) return bad('The description has two sections of one kind.');
      seen[sections[i]] = 1;
    }
    // One transport: a single BUNDLE group naming every section and nothing else.
    if (groups.length !== 1) return bad('The media is not bundled onto the existing connection.');
    var g = /^a=group:BUNDLE((?: \S+)+)$/.exec(groups[0]);
    if (!g) return bad('The media is not bundled onto the existing connection.');
    var bundled = g[1].trim().split(' ');
    if (mids.length !== sections.length || bundled.length !== mids.length || mids.some(function (x) { return bundled.indexOf(x) < 0; }) || new Set(mids).size !== mids.length) {
      return bad('The media is not bundled onto the existing connection.');
    }
    // Every fingerprint is the one the peer proved, and only the one hash.
    if (!prints.length) return bad('The description names no certificate.');
    var want = String(opts.peerFp || '').toUpperCase();
    if (!want) return bad('No proven fingerprint to compare with.');
    for (var j = 0; j < prints.length; j++) {
      var p = /^sha-256 (\S+)$/i.exec(prints[j]);
      if (!p || p[1].toUpperCase() !== want) return bad('The description names a different certificate than the one that was proven.');
    }
    // The same ICE credentials throughout, and the ones the connection already has: no restart, no second path.
    var u0 = ufrags[0], p0 = pwds[0];
    if (!u0 || !p0 || ufrags.some(function (x) { return x !== u0; }) || pwds.some(function (x) { return x !== p0; })) return bad('The description changes the connection credentials.');
    if (opts.remoteSdp) {
      var ru = first(/^a=ice-ufrag:(\S+)/m, opts.remoteSdp), rp = first(/^a=ice-pwd:(\S+)/m, opts.remoteSdp);
      if (ru !== u0 || rp !== p0) return bad('The description changes the connection credentials.');
    }
    return { ok: true, kinds: sections };
  }

  return { check: check, MAX_SDP: MAX_SDP };
});
