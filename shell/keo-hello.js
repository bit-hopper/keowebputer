// keo connection codes and peer proofs. No storage, no WebRTC, no DOM: pure functions over WebCrypto, so a Node test can check
// them. Two things live here because they belong together:
//
// 1. THE CODE two devices swap (paste, or a QR) to open a direct connection: "keo2." + base64url of a small binary record, about
//    130 characters. It carries only what the other side needs to reach this one: the ICE user fragment and password, the DTLS
//    certificate fingerprint, the host addresses (IPv4 or IPv6 and port), and when it was made. An answer also carries a short
//    tag of the invitation it answers, so an answer for another invitation is refused at once instead of failing to connect
//    later. A 3-byte checksum catches a mistyped or cut-off code. The session description (SDP) is rebuilt from a template on
//    the other side (codeSdp): a data channel needs nothing else.
//    The code is NOT signed and says nothing about who made it. Anyone who holds it can use it to try to connect, and anyone who
//    can alter it on the way can point it at a different endpoint. Both are handled by 2.
//
// 2. THE PEER PROOF each side sends over the channel as soon as it opens, before anything else is accepted. It is signed by the
//    device key of the sender's signed-in identity over BOTH DTLS fingerprints (the offerer's, then the answerer's), so it only
//    verifies for the very connection it was made for: a code pointed at a different endpoint, or a proof relayed from another
//    connection, fails because the fingerprints do not match what this side negotiated. The proof carries what a stranger needs
//    to check it with no server (keo-did.js verifyInception): the inception event with its signatures and the delegation
//    certificate of the device key (7.6). The certificate is either the inception itself (cert.via = 'inception': the device is
//    listed in the inception's devices) or a sign-in certificate whose passkey assertion covers H(cert).
//    `name` is optional and only what the sender chose to show; the identity's label stays on its device unless passed in.
// What a valid proof says: someone holding this identity's passkey-delegated device key is at the other end of THIS connection
// right now. It does not say that the person is the one you meant to reach: compare the DID (or what a contact list knows
// about it) by other means.
(function (root, factory) {
  var kd = typeof module === 'object' && module.exports ? require('./keo-did.js') : root.keoDid;
  var api = factory(kd);
  if (typeof module === 'object' && module.exports) module.exports = api; else root.keoHello = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (kd) {
  'use strict';

  var subtle = globalThis.crypto && globalThis.crypto.subtle;
  var enc = new TextEncoder();
  var PREFIX = 'keo2.', FORMAT = 2, PURPOSE = 'keo-p2p-channel';
  var MAX_CODE = 1024, MAX_CANDS = 8, MAX_NAME = 64, TAG_BYTES = 6, SUM_BYTES = 3;
  var MAX_AGE_MS = 15 * 60 * 1000, SKEW_MS = 2 * 60 * 1000;

  // ---- addresses and fingerprints -------------------------------------------------------------------------------------
  function ipv4ToBytes(s) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    if (!m) return null;
    var out = new Uint8Array(4);
    for (var i = 0; i < 4; i++) { var v = +m[i + 1]; if (v > 255) return null; out[i] = v; }
    return out;
  }
  function ipv6ToBytes(s) {
    if (!/^[0-9a-fA-F:]+$/.test(s) || s.indexOf(':::') >= 0) return null;
    var parts = s.split('::');
    if (parts.length > 2) return null;
    var head = parts[0] ? parts[0].split(':') : [], tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
    var missing = 8 - head.length - tail.length;
    if (parts.length === 1 ? head.length !== 8 : missing < 1) return null;      // "::" stands for at least one group
    var groups = head.concat(parts.length === 2 ? new Array(missing).fill('0') : [], tail), out = new Uint8Array(16);
    for (var i = 0; i < 8; i++) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
      var v = parseInt(groups[i], 16); out[i * 2] = v >> 8; out[i * 2 + 1] = v & 255;
    }
    return out;
  }
  function bytesToIpv4(b) { return b[0] + '.' + b[1] + '.' + b[2] + '.' + b[3]; }
  function bytesToIpv6(b) { var g = []; for (var i = 0; i < 16; i += 2) g.push(((b[i] << 8) | b[i + 1]).toString(16)); return g.join(':'); }
  // An address that cannot work as the other side's way in: this machine itself, "any", or a link-local IPv6 address (needs a
  // zone this record does not carry). mDNS names (".local") never reach here: they are not literals.
  function usable(bytes) {
    if (bytes.length === 4) return bytes[0] !== 0 && bytes[0] !== 127 && bytes[0] < 224;
    var allZero = true, i;
    for (i = 0; i < 16; i++) if (bytes[i]) allZero = false;
    if (allZero || (bytes.slice(0, 15).every(function (x) { return x === 0; }) && bytes[15] === 1)) return false;   // :: and ::1
    return !(bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) && bytes[0] !== 0xff;
  }
  function fpToBytes(f) {
    if (!/^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/.test(f)) return null;
    return Uint8Array.from(f.split(':').map(function (h) { return parseInt(h, 16); }));
  }
  function bytesToFp(b) { return Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16).toUpperCase(); }).join(':'); }

  // ---- the code ---------------------------------------------------------------------------------------------------------
  // From the local description the browser made. Only what a data channel needs: the first component's UDP host candidates.
  // Throws an Error with a sentence for a person when the description is unusable (no address: not online).
  function fromSdp(sdp, role, opts) {
    opts = opts || {};
    var g = function (re) { var m = re.exec(sdp); return m && m[1]; };
    var u = g(/^a=ice-ufrag:(\S+)/m), p = g(/^a=ice-pwd:(\S+)/m), f = g(/^a=fingerprint:sha-256 (\S+)/mi);
    if (!u || !p || !f || !fpToBytes(f)) throw new Error('This device could not make a connection description.');
    var cands = [], seen = {};
    sdp.split(/\r?\n/).forEach(function (l) {
      var m = /^a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ host(?: |$)/.exec(l);
      if (!m) return;
      var port = +m[2], b = ipv4ToBytes(m[1]) || ipv6ToBytes(m[1]);
      if (!b || !usable(b) || port < 1 || port > 65535 || seen[m[1] + '/' + port] || cands.length >= MAX_CANDS) return;
      seen[m[1] + '/' + port] = 1;
      cands.push([b.length === 4 ? bytesToIpv4(b) : bytesToIpv6(b), port]);
    });
    if (!cands.length) throw new Error('This device has no network address to connect with. Is it online?');
    return { role: role, time: opts.now || Date.now(), u: u, p: p, f: f.toUpperCase(), c: cands, tag: opts.tag || null };
  }

  // A data-channel-only session description from a code. role is the role of the device the code came from: an offer is
  // "actpass", the answer to it is "active" (the DTLS role a browser's answerer takes; checked 2026-11-03 by rebuilding both sides in one browser).
  function codeSdp(c) {
    var first = c.c[0], v6 = first[0].indexOf(':') >= 0;
    var lines = ['v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0',
      'm=application ' + first[1] + ' UDP/DTLS/SCTP webrtc-datachannel', 'c=IN ' + (v6 ? 'IP6 ' : 'IP4 ') + first[0]];
    c.c.forEach(function (x, i) { lines.push('a=candidate:' + (1000 + i) + ' 1 udp ' + (2122260223 - i * 1000) + ' ' + x[0] + ' ' + x[1] + ' typ host generation 0'); });
    lines.push('a=ice-ufrag:' + c.u, 'a=ice-pwd:' + c.p, 'a=fingerprint:sha-256 ' + c.f, 'a=setup:' + (c.role === 'offer' ? 'actpass' : 'active'),
      'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144');
    return lines.join('\r\n') + '\r\n';
  }

  // Names the invitation an answer belongs to: the first bytes of SHA-256 over the offer's credentials and fingerprint.
  function offerTag(c) { return kd.sha256(enc.encode(c.u + '|' + c.p + '|' + c.f)).then(function (h) { return kd.b64u(h.slice(0, TAG_BYTES)); }); }

  async function encodeCode(c) {
    var u = enc.encode(c.u), p = enc.encode(c.p), parts = [], n = 0;
    function put(arr) { parts.push(Uint8Array.from(arr)); n += arr.length; }
    var secs = Math.floor(c.time / 1000);
    put([FORMAT, c.role === 'answer' ? 1 : 0, (secs >>> 24) & 255, (secs >>> 16) & 255, (secs >>> 8) & 255, secs & 255, u.length]); put(u);
    put([p.length]); put(p); put(fpToBytes(c.f)); put([c.c.length]);
    c.c.forEach(function (x) { var b = ipv4ToBytes(x[0]) || ipv6ToBytes(x[0]); put([b.length === 4 ? 4 : 6]); put(b); put([x[1] >> 8, x[1] & 255]); });
    if (c.role === 'answer') put(kd.unb64u(c.tag));
    var body = new Uint8Array(n), off = 0;
    parts.forEach(function (a) { body.set(a, off); off += a.length; });
    var sum = (await kd.sha256(body)).slice(0, SUM_BYTES), all = new Uint8Array(n + SUM_BYTES);
    all.set(body); all.set(sum, n);
    return PREFIX + kd.b64u(all);
  }

  // Throws an Error whose message can be shown to a person. opts: { now, role } (role: 'offer' or 'answer', what is wanted).
  async function decodeCode(text, opts) {
    opts = opts || {};
    var now = opts.now || Date.now();
    text = String(text == null ? '' : text).replace(/\s+/g, '');
    if (text.indexOf(PREFIX) !== 0) throw new Error('This is not a keo connection code.');
    if (text.length > MAX_CODE || !/^[A-Za-z0-9_-]+$/.test(text.slice(PREFIX.length))) throw new Error('This connection code is damaged.');
    var all;
    try { all = kd.unb64u(text.slice(PREFIX.length)); } catch (e) { throw new Error('This connection code is damaged.'); }
    var damaged = new Error('This connection code is damaged.');
    if (all.length < 8 + SUM_BYTES) throw damaged;
    var body = all.slice(0, all.length - SUM_BYTES), sum = all.slice(all.length - SUM_BYTES), want = (await kd.sha256(body)).slice(0, SUM_BYTES);
    for (var i = 0; i < SUM_BYTES; i++) if (sum[i] !== want[i]) throw damaged;
    var pos = 0;
    function take(k) { if (pos + k > body.length) throw damaged; var s = body.slice(pos, pos + k); pos += k; return s; }
    if (take(1)[0] !== FORMAT) throw new Error('This connection code is from a different version of keo.');
    var role = take(1)[0] === 1 ? 'answer' : 'offer', t = take(4);
    var secs = ((t[0] << 24) | (t[1] << 16) | (t[2] << 8) | t[3]) >>> 0;
    var ul = take(1)[0], u = String.fromCharCode.apply(null, take(ul)), pl = take(1)[0], p = String.fromCharCode.apply(null, take(pl));
    if (!/^[A-Za-z0-9+\/]{4,64}$/.test(u) || !/^[A-Za-z0-9+\/]{22,64}$/.test(p)) throw damaged;
    var f = bytesToFp(take(32)), nc = take(1)[0];
    if (nc < 1 || nc > MAX_CANDS) throw damaged;
    var cands = [];
    for (var k = 0; k < nc; k++) {
      var fam = take(1)[0];
      if (fam !== 4 && fam !== 6) throw damaged;
      var a = take(fam === 4 ? 4 : 16), pt = take(2), port = (pt[0] << 8) | pt[1];
      if (!usable(a) || port < 1) throw damaged;
      cands.push([fam === 4 ? bytesToIpv4(a) : bytesToIpv6(a), port]);
    }
    var tag = role === 'answer' ? kd.b64u(take(TAG_BYTES)) : null;
    if (pos !== body.length) throw damaged;
    if (opts.role && role !== opts.role) throw new Error(role === 'offer' ? 'This is an invitation. An answer is needed here.' : 'This is an answer. An invitation is needed here.');
    var time = secs * 1000;
    if (time < now - MAX_AGE_MS) throw new Error('This connection code is too old. Ask for a new one.');
    if (time > now + SKEW_MS) throw new Error('This connection code is dated in the future (check the clock).');
    return { role: role, time: time, u: u, p: p, f: f, c: cands, tag: tag };
  }

  // ---- the peer proof ---------------------------------------------------------------------------------------------------
  function plainJwk(j) { return { kty: j.kty, crv: j.crv, x: j.x, y: j.y }; }
  function signedBytes(hello) { return enc.encode(kd.canonicalJson(hello)); }

  // fps: [the offerer's fingerprint, the answerer's fingerprint] as the codes carry them. `proof` is { did, inception, sigs, events?, cert }
  // as keo-identity.js deviceProof returns it; the caller signs signedBytes(result) with signWithDevice. `events` is the log after the
  // inception (keo-did.js verifyLog): an identity whose passkey on this origin was added later cannot be checked without it. It is left
  // out when empty, so a proof from an identity that never added a key has the shape it always had.
  function proofBuild(role, fps, proof, opts) {
    opts = opts || {};
    var h = { v: 1, purpose: PURPOSE, role: role, fps: fps.slice(), time: new Date(opts.now || Date.now()).toISOString(),
      did: proof.did, inception: proof.inception, inceptionSigs: proof.sigs, cert: proof.cert };
    if (proof.events && proof.events.length) h.events = proof.events;
    if (opts.name) h.name = String(opts.name).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    return h;
  }

  // null when the certificate is good, else a sentence saying what is wrong.
  // `state` is the identity's keys and devices after the whole log (keo-did.js verifyLog); `inception` is the inception alone, which a
  // certificate of kind 'inception' is checked against.
  async function certError(cert, state, inception, did, now, audience) {
    if (!cert || typeof cert !== 'object' || cert.v !== 1 || cert.did !== did) return 'the delegation is not for this identity';
    var exp = Date.parse(cert.exp), iat = Date.parse(cert.issuedAt);
    if (!(exp > now)) return 'the delegation has expired';
    if (!(iat <= now + SKEW_MS)) return 'the delegation is dated in the future';
    if (audience && cert.aud !== audience) return 'the delegation is for another app';
    if (!Array.isArray(cert.scope) || cert.scope.indexOf('sign') < 0) return 'the delegation does not allow signing';
    var dj = cert.devicePubKeyJwk;
    if (!dj || dj.kty !== 'EC' || dj.crv !== 'P-256' || typeof dj.x !== 'string' || typeof dj.y !== 'string' || dj.d !== undefined) return 'the device key is malformed';
    var key = state.authority.keys.filter(function (k) { return k.id === cert.authorityKeyId; })[0];
    if (!key) return 'the delegation names an authority key the identity does not have';
    if (cert.via === 'inception' || cert.via === 'log') {
      // 'inception': the device is in the inception, which the authority key signed. 'log': it was added by a later event, which an
      // existing key and the new key both signed. Either way no further signature is needed to vouch for it.
      var want = kd.canonicalJson(plainJwk(dj));
      var from = cert.via === 'inception' ? inception.state.devices : state.devices;
      var listed = (from || []).some(function (d) { return kd.canonicalJson(plainJwk(d.jwk)) === want; });
      return listed ? null : 'the device is not listed in the identity\'s ' + (cert.via === 'inception' ? 'inception' : 'log');
    }
    if (cert.via !== undefined) return 'the delegation is of an unknown kind';
    // a sign-in certificate: the passkey signed H(cert as it was before the assertion was added)
    var bare = {};
    Object.keys(cert).forEach(function (k) { if (k !== 'assertion') bare[k] = cert[k]; });
    var ok = cert.assertion && await kd.verifySignature(cert.assertion, key, await kd.eventHash(bare), 'session');
    return ok ? null : 'the delegation\'s passkey signature does not verify';
  }

  // Checks a proof received over the channel: msg = { hello, sig }. opts: { role (the role the SENDER must have), fps (what THIS
  // side negotiated: it must equal what the sender signed), now, audience (the origin the certificate must be for) }.
  // Resolves { ok, error } or { ok, did, name }.
  async function verifyProof(msg, opts) {
    opts = opts || {};
    var now = opts.now || Date.now(), h = msg && msg.hello;
    function fail(m) { return { ok: false, error: m }; }
    try {
      if (!h || typeof h !== 'object' || typeof msg.sig !== 'string' || h.v !== 1 || h.purpose !== PURPOSE) return fail('The other side sent something that is not a keo proof.');
      if (h.role !== opts.role) return fail('The other side\'s proof is for the wrong end of the connection.');
      if (!Array.isArray(h.fps) || h.fps.length !== 2 || !opts.fps || h.fps[0] !== opts.fps[0] || h.fps[1] !== opts.fps[1]) return fail('The other side\'s proof is for a different connection.');
      var t = Date.parse(h.time);
      if (!(t > now - MAX_AGE_MS)) return fail('The other side\'s proof is too old.');
      if (t > now + SKEW_MS) return fail('The other side\'s proof is dated in the future (check the clock).');
      if (h.name !== undefined && (typeof h.name !== 'string' || h.name.length > MAX_NAME)) return fail('The other side sent a bad name.');
      var who = await signerError(msg, h, now, opts.audience);
      if (who.error) return fail(who.error);
      return { ok: true, did: h.did, name: h.name || null };
    } catch (e) {
      return fail('The other side\'s proof could not be checked.');
    }
  }

  // The part every signed statement shares: the identity (its log verifies and names this DID), the device key (vouched for by that
  // identity, see certError) and the signature of that device key over the statement as it was sent. Resolves { did } or { error }.
  // It checks nothing about what the statement SAYS: the caller does that first (purpose, role, time, who it is for).
  async function signerError(msg, h, now, audience) {
    var v = await kd.verifyLog({ inception: h.inception, sigs: h.inceptionSigs, events: h.events });
    if (!v.ok) return { error: 'The identity does not verify: ' + v.error };
    if (v.did !== h.did) return { error: 'The identity does not match its proof.' };
    var ce = await certError(h.cert, v.state, h.inception, h.did, now, audience);
    if (ce) return { error: 'The other side\'s device is not vouched for: ' + ce + '.' };
    var devKey = await subtle.importKey('jwk', plainJwk(h.cert.devicePubKeyJwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, devKey, kd.unb64u(msg.sig), signedBytes(h)))) return { error: 'The other side\'s signature does not match.' };
    return { did: h.did };
  }

  // ---- the dial request ---------------------------------------------------------------------------------------------------
  // "Please answer this connection code": what a device sends, on the local network, to a friend it found there (keo-lan.js). It is
  // signed by the device key of the sender's signed-in identity and names WHO it is for, WHAT it asks to be answered (the hash of the
  // code, so the request cannot be used with another code) and WHEN, so the receiving side can answer only a friend it has added,
  // only once, and only while the request is fresh. It proves who asks; it does not prove who answers (the channel's own proof does
  // that), and it is not encrypted, so anyone on the network can read it. `proof` is as for proofBuild; the caller signs
  // signedBytes(result) with signWithDevice.
  var DIAL_PURPOSE = 'keo-lan-dial', DIAL_AGE_MS = 60 * 1000, NONCE = /^[A-Za-z0-9_-]{16,32}$/;
  function dialBuild(proof, o) {
    var h = { v: 1, purpose: DIAL_PURPOSE, to: o.to, nonce: o.nonce, c: o.c, time: new Date(o.now || Date.now()).toISOString(),
      did: proof.did, inception: proof.inception, inceptionSigs: proof.sigs, cert: proof.cert };
    if (proof.events && proof.events.length) h.events = proof.events;
    return h;
  }
  // msg = { hello, sig }. opts: { to (the DID this side is), c (the hash of the code that came with it), now, audience }.
  // Resolves { ok, error } or { ok, did, nonce, time }. The nonce is returned, not remembered: the caller keeps the ones it has seen.
  async function verifyDial(msg, opts) {
    opts = opts || {};
    var now = opts.now || Date.now(), h = msg && msg.hello;
    function fail(m) { return { ok: false, error: m }; }
    try {
      if (!h || typeof h !== 'object' || typeof msg.sig !== 'string' || h.v !== 1 || h.purpose !== DIAL_PURPOSE) return fail('That is not a keo dial request.');
      if (typeof h.to !== 'string' || h.to !== opts.to) return fail('That dial request is for someone else.');
      if (typeof h.c !== 'string' || h.c !== opts.c) return fail('That dial request is for a different code.');
      if (typeof h.nonce !== 'string' || !NONCE.test(h.nonce)) return fail('That dial request has a bad nonce.');
      var t = Date.parse(h.time);
      if (!(t > now - DIAL_AGE_MS)) return fail('That dial request is too old.');
      if (t > now + SKEW_MS) return fail('That dial request is dated in the future (check the clock).');
      var who = await signerError(msg, h, now, opts.audience);
      if (who.error) return fail(who.error);
      return { ok: true, did: h.did, nonce: h.nonce, time: t };
    } catch (e) {
      return fail('That dial request could not be checked.');
    }
  }

  // ---- the card -----------------------------------------------------------------------------------------------------------
  // "Here is where my device can be asked to connect": a device's own statement of the helper addresses it can be reached through
  // (a helper is a program at a stable address that carries the SETUP of a connection, never its media). It is signed by that device's
  // key like a proof, so only a device of the identity can say where the identity's device is, and the signature does not depend on how the
  // card reached anyone: a live connection, a code swap, a QR or a link all carry the same bytes. What a card is NOT: proof that the
  // address works now (addresses go stale; a failed attempt is the only test), proof the helper is honest (a helper carries a signed
  // request and the connection's own proof still decides who is at the other end), or a way to find a stranger (it is only ever shown
  // to people who are friends). `seq` only moves forward, so an old card cannot roll an address back; mergeCard is the one rule for that.
  // `time` says when it was made. It is not checked for age here, because a card is kept: the device certificate inside it (which is
  // short-lived) decides whether the card could still be made today, and a stored card is NOT checked again.
  var CARD_PURPOSE = 'keo-card', MAX_HELPERS = 4, MAX_CARD_DEVICES = 8, MAX_SEQ = 4294967295, HELPER_KINDS = ['ws', 'http'];
  var LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  // null when the helper is well formed, else a sentence. The host is a literal address or a lower-case name with a dot; nothing that can only
  // mean "this machine" or "this network segment" (that cannot be a way in from elsewhere), and not a ".local" name (not found beyond one network).
  function helperError(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return 'a helper is not a record';
    if (HELPER_KINDS.indexOf(x.kind) < 0) return 'a helper has an unknown kind';
    if (typeof x.port !== 'number' || x.port % 1 !== 0 || x.port < 1 || x.port > 65535) return 'a helper has a bad port';
    var h = x.host;
    if (typeof h !== 'string' || !h || h.length > 253) return 'a helper has a bad host';
    var v4 = ipv4ToBytes(h), v6 = v4 ? null : ipv6ToBytes(h);
    if (v4) return usable(v4) && bytesToIpv4(v4) === h ? null : 'a helper has an address that cannot be reached from elsewhere';
    if (v6) return usable(v6) && bytesToIpv6(v6) === h ? null : 'a helper has an address that cannot be reached from elsewhere';
    var labels = h.split('.');
    if (labels.length < 2 || labels[labels.length - 1] === 'local' || /^[0-9]+$/.test(labels[labels.length - 1]) || !labels.every(function (l) { return LABEL.test(l); })) return 'a helper has a bad host name';
    return null;
  }
  function canonicalHost(h) {
    var v4 = ipv4ToBytes(h), v6 = v4 ? null : ipv6ToBytes(h);
    return v4 ? bytesToIpv4(v4) : v6 ? bytesToIpv6(v6) : h.toLowerCase();
  }
  function plainHelper(x) { return { kind: x.kind, host: x.host, port: x.port }; }

  // `proof` is as for proofBuild; o: { helpers: [{ kind, host, port }], seq (a whole number, 1 or more), now }. Throws a sentence when the
  // helpers are not valid, so a bad address is never signed. The caller signs signedBytes(result) with signWithDevice.
  function cardBuild(proof, o) {
    var helpers = o && o.helpers;
    if (!Array.isArray(helpers) || helpers.length > MAX_HELPERS) throw new Error('A card holds at most ' + MAX_HELPERS + ' helpers.');
    // The host is written the one way a verifier accepts (expanded IPv6, lower-case name), so a person's "2001:db8::7" is not refused.
    helpers = helpers.map(function (x) { return x && typeof x === 'object' && typeof x.host === 'string' ? { kind: x.kind, host: canonicalHost(x.host), port: x.port } : x; });
    for (var i = 0; i < helpers.length; i++) { var e = helperError(helpers[i]); if (e) throw new Error('That helper is not valid: ' + e + '.'); }
    if (typeof o.seq !== 'number' || o.seq % 1 !== 0 || o.seq < 1 || o.seq > MAX_SEQ) throw new Error('A card needs a whole number to count its versions.');
    var h = { v: 1, purpose: CARD_PURPOSE, seq: o.seq, helpers: helpers.map(plainHelper), time: new Date(o.now || Date.now()).toISOString(),
      did: proof.did, inception: proof.inception, inceptionSigs: proof.sigs, cert: proof.cert };
    if (proof.events && proof.events.length) h.events = proof.events;
    return h;
  }
  // The id the identity's log gives a device key (keo-identity.js): the hash of the key in its canonical form.
  async function deviceIdOf(jwk) { return kd.b64u(await kd.sha256(enc.encode(kd.canonicalJson(plainJwk(jwk))))); }
  // msg = { hello, sig }. opts: { did (the identity the card must be from, when the caller knows it: a card learned over a connection that
  // proved a DID), now, audience }. Resolves { ok, error } or { ok, did, deviceId, helpers, seq, time }.
  async function verifyCard(msg, opts) {
    opts = opts || {};
    var now = opts.now || Date.now(), h = msg && msg.hello;
    function fail(m) { return { ok: false, error: m }; }
    try {
      if (!h || typeof h !== 'object' || typeof msg.sig !== 'string' || h.v !== 1 || h.purpose !== CARD_PURPOSE) return fail('That is not a keo card.');
      if (opts.did && h.did !== opts.did) return fail('That card is from someone else.');
      if (typeof h.seq !== 'number' || h.seq % 1 !== 0 || h.seq < 1 || h.seq > MAX_SEQ) return fail('That card has a bad version number.');
      if (!Array.isArray(h.helpers) || h.helpers.length > MAX_HELPERS) return fail('That card has too many helpers.');
      for (var i = 0; i < h.helpers.length; i++) {
        var e = helperError(h.helpers[i]);
        if (e) return fail('That card is not valid: ' + e + '.');
        if (Object.keys(h.helpers[i]).length !== 3) return fail('That card is not valid: a helper has extra parts.');
      }
      var t = Date.parse(h.time);
      if (!(t > 0)) return fail('That card has no valid date.');
      if (t > now + SKEW_MS) return fail('That card is dated in the future (check the clock).');
      var who = await signerError(msg, h, now, opts.audience);
      if (who.error) return fail(who.error);
      return { ok: true, did: h.did, deviceId: await deviceIdOf(h.cert.devicePubKeyJwk), helpers: h.helpers.map(plainHelper), seq: h.seq, time: t };
    } catch (e) {
      return fail('That card could not be checked.');
    }
  }
  // The one rule for keeping cards. `devices` is what is kept for one friend: { <deviceId>: { helpers, seq, time } } (or null/undefined).
  // `card` is what verifyCard resolved. A card replaces what is kept for that device only if its seq is HIGHER (a replay of the same or an
  // older card changes nothing, which also means two different cards with one seq keep the first). At most MAX_CARD_DEVICES devices are kept:
  // a new one over the limit pushes out the device whose card is the oldest. Returns { devices, changed } and never changes its arguments.
  function mergeCard(devices, card) {
    var out = {}, have = devices || {};
    Object.keys(have).forEach(function (k) { out[k] = have[k]; });
    var before = out[card.deviceId];
    if (before && !(card.seq > before.seq)) return { devices: out, changed: false };
    if (!before) {
      var ids = Object.keys(out);
      if (ids.length >= MAX_CARD_DEVICES) {
        ids.sort(function (a, b) { return out[a].time - out[b].time; });
        delete out[ids[0]];
      }
    }
    out[card.deviceId] = { helpers: card.helpers.map(plainHelper), seq: card.seq, time: card.time };
    return { devices: out, changed: true };
  }

  return { PREFIX: PREFIX, MAX_AGE_MS: MAX_AGE_MS, DIAL_AGE_MS: DIAL_AGE_MS, MAX_HELPERS: MAX_HELPERS, MAX_CARD_DEVICES: MAX_CARD_DEVICES, fromSdp: fromSdp, codeSdp: codeSdp, offerTag: offerTag, encodeCode: encodeCode, decodeCode: decodeCode,
    proofBuild: proofBuild, signedBytes: signedBytes, verifyProof: verifyProof, dialBuild: dialBuild, verifyDial: verifyDial,
    helperError: helperError, cardBuild: cardBuild, verifyCard: verifyCard, mergeCard: mergeCard, deviceIdOf: deviceIdOf };
});
