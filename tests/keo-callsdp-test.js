// Node test for keo-callsdp.js (what a call description received from the peer must look like): no browser.
// Usage: node keo-callsdp-test.js
const path = require('path');
const sdp = require(path.join(__dirname, '..', 'shell', 'keo-callsdp.js'));
let passed = 0;
const ok = (name, cond, extra) => { if (!cond) { console.error('FAIL ' + name + (extra ? ' ' + JSON.stringify(extra) : '')); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } };

const FP = 'B8:5D:33:30:C1:13:19:E5:C0:53:DA:B0:A6:9D:3C:B6:00:16:7E:C0:1F:3A:44:5F:4B:E2:15:1B:D6:28:11:7C';
const OTHER = '3D:97:39:3B:D2:58:A0:27:85:67:56:A1:50:74:E1:A3:2C:87:BB:83:D9:11:DA:8F:D2:B4:BD:99:E7:1C:2C:C8';
// A description shaped like the one a browser makes when media is added to a data-only connection: one data section, then the
// media sections, all bundled, each repeating the credentials and fingerprint.
function make(o) {
  o = Object.assign({ kinds: ['application', 'audio', 'video'], fp: FP, u: 'HBmx', p: 'ML6jE3l6JwvKT19OeM8/rdRJ', extra: {} }, o);
  const mids = o.kinds.map((_, i) => String(i));
  const L = ['v=0', 'o=- 8359877814220395974 3 IN IP4 127.0.0.1', 's=-', 't=0 0', o.group || ('a=group:BUNDLE ' + mids.join(' '))];
  o.kinds.forEach((k, i) => {
    L.push('m=' + k + ' 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=ice-ufrag:' + (o.extra['u' + i] || o.u), 'a=ice-pwd:' + o.p,
      'a=fingerprint:' + (o.extra['f' + i] || ('sha-256 ' + o.fp)), 'a=setup:actpass', 'a=mid:' + (o.mids ? o.mids[i] : i));
  });
  return L.join('\r\n') + '\r\n';
}
const chk = (s, extra) => sdp.check(s, Object.assign({ peerFp: FP }, extra));
const remote = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=ice-ufrag:HBmx\r\na=ice-pwd:ML6jE3l6JwvKT19OeM8/rdRJ\r\na=fingerprint:sha-256 ' + FP + '\r\n';

const good = chk(make({}), { remoteSdp: remote });
ok('a bundled audio+video description with the proven fingerprint and unchanged credentials passes', good.ok === true && good.kinds.join() === 'application,audio,video', good);
ok('audio only passes', chk(make({ kinds: ['application', 'audio'] })).ok);
ok('the fingerprint is compared without regard to case', chk(make({ fp: FP.toLowerCase() })).ok);
ok('a description for a data section alone passes (a second call after the media sections are gone)', chk(make({ kinds: ['application'] })).ok);

const err = (r) => r.ok === false ? r.error : null;
ok('a different certificate is refused', /different certificate/.test(err(chk(make({ fp: OTHER })))), chk(make({ fp: OTHER })));
ok('ONE section with another certificate is enough to refuse (the others carry the right one)', /different certificate/.test(err(chk(make({ extra: { f2: 'sha-256 ' + OTHER } })))));
ok('another hash algorithm is refused, even with the right bytes', /different certificate/.test(err(chk(make({ extra: { f1: 'sha-1 ' + FP } })))));
ok('no fingerprint line at all is refused', /names no certificate/.test(err(chk(make({}).replace(/^a=fingerprint.*\r\n/gm, '')))));
ok('without a proven fingerprint to compare with, nothing passes', /No proven fingerprint/.test(err(sdp.check(make({}), {}))));
ok('a description that does not start with the data section is refused', /does not start/.test(err(chk(make({ kinds: ['audio', 'application'] })))));
ok('two sections of one kind are refused', /two sections/.test(err(chk(make({ kinds: ['application', 'audio', 'audio'] })))));
ok('an unknown kind (text) is refused', /unknown kind/.test(err(chk(make({ kinds: ['application', 'text'] })))));
ok('more than three sections are refused', /unexpected number/.test(err(chk(make({ kinds: ['application', 'audio', 'video', 'audio'] })))));
ok('no BUNDLE group is refused (a second transport would escape the proof)', /not bundled/.test(err(chk(make({ group: 'a=msid-semantic: WMS' })))));
ok('a BUNDLE that leaves a section out is refused', /not bundled/.test(err(chk(make({ group: 'a=group:BUNDLE 0 1' })))));
ok('a BUNDLE naming a section that does not exist is refused', /not bundled/.test(err(chk(make({ group: 'a=group:BUNDLE 0 1 9' })))));
ok('two BUNDLE groups are refused', /not bundled/.test(err(chk(make({}).replace('a=group:BUNDLE 0 1 2', 'a=group:BUNDLE 0 1 2\r\na=group:BUNDLE 0')))));
ok('repeated section ids are refused', /not bundled/.test(err(chk(make({ mids: ['0', '1', '1'] })))));
ok('changed ICE credentials against the connection are refused (no restart, no second path)', /credentials/.test(err(chk(make({ u: 'ZZZZ' }), { remoteSdp: remote }))));
ok('credentials that differ between sections are refused', /credentials/.test(err(chk(make({ extra: { u2: 'QQQQ' } })))));
ok('missing credentials are refused', /credentials/.test(err(chk(make({}).replace(/^a=ice-pwd.*\r\n/gm, '')))));
ok('an empty, non-text or oversized description is refused', !chk('').ok && !chk(null).ok && !chk({}).ok && !chk('x'.repeat(sdp.MAX_SDP + 1)).ok);
ok('a control character is refused', /control character/.test(err(chk(make({}) + '\u0000'))));
console.log(passed + ' checks passed');
