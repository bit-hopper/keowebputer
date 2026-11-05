// keo peer connections and file sharing, SHELL side. Runs in the extension's own page. The sandboxed world cannot capture a
// camera and is not trusted with keys, so connections live here and the world drives them through the bridge ops in shell.js
// (p2p.*), receiving plain-data events back.
//
// No server, no STUN or TURN: a connection is made by swapping two short codes by hand (keo-hello.js; about 130 characters, so
// they also fit a QR), so it works between two devices that can reach each other directly (the same network). The invitation is
// made by one side (offer), pasted into the other (answer), whose reply is pasted back (finish). The codes are not signed and
// name nobody. WHO is at the other end is settled over the channel itself: as soon as it opens, each side sends a proof signed
// by the device key of its signed-in identity over both DTLS fingerprints (keo-hello.js), and until the other side's proof has
// been checked nothing else is accepted. A code pointed at a different endpoint therefore gets a different identity, or none.
// Both sides must be signed in; neither needs a host.
//
// States: invited (offerer, waiting for the answer) / connecting / open (the channel is up, the peer is NOT yet proven: nothing
// but the proof is accepted) / ready (the peer's proof checked and ours sent: files can move) / closed.
// The data channel then carries JSON control messages and binary file chunks (a 4-byte file number, then up to CHUNK bytes). A
// file moves only after the receiving person said yes (p2p.respond): the sender offers {name, size}, the receiver asks, answers,
// and only then do chunks flow. Received bytes stay in THIS page: the world is told names, sizes and progress, never the bytes,
// and a received file leaves only through p2p.save, which hands it to the browser's download. The channel itself is
// authenticated and integrity-protected by DTLS, so there is no extra file hash; the size announced up front is enforced.
// A peer is a stranger until a person compares its DID with what they expect: a valid proof says which identity is at the other
// end, not that it is the one you meant. Show the DID.
//
// Limits (a hostile peer is assumed): files up to MAX_FILE, at most MAX_ASKED unanswered offers from one peer, control messages
// up to 4 KiB (the proof 24 KiB), any malformed or early message closes the connection, a peer that does not prove itself within
// PROOF_MS is dropped.
// Calls (keo-call.js) and text messages (keo-dm.js) ride the same proven channel: they attach by message prefix (see attach) and
// are handed a message only after the peer's proof has been checked; media is added to this same connection by renegotiating.
// FRIENDS: a proven DID is still a stranger. Files, messages and calls move only between friends: the person here has added the device
// after comparing its words (keo-contacts.js, keo-friend.js) AND the device has told us, on this connection, that it has added us. A
// device that is not a friend may say only that (the 'friend' prefix); anything else from it closes the connection, and so does the
// loss of a friendship while connected. Our own sends are refused with a sentence before anything goes out.
// RECONNECTING to a friend is a new invitation, made by hand like the first, but ADDRESSED: offer({ expect: <DID> }) closes the connection
// if the device that answers proves any other identity (the codes name nobody, so only the proof can say). Nothing reconnects by itself.
// Known gaps: connections are not closed when the session expires (so neither is a call); the codes carry UDP host addresses only; nothing is retried
// after a failure; one data channel, files go one at a time per direction as the sender pumps them in order.
(function () {
  'use strict';
  var kd = window.keoDid, hello = window.keoHello, ident = window.keoIdentity;
  var CHUNK = 16 * 1024, HIGH_WATER = 1024 * 1024, LOW_WATER = 256 * 1024;
  var MAX_FILE = 1024 * 1024 * 1024, MAX_ASKED = 8, MAX_OFFERED = 16, MAX_CONTROL = 4096, MAX_PROOF = 24 * 1024;
  var GATHER_MS = 8000, OPEN_MS = 45000, PROOF_MS = 20000, LABEL = 'keo-p2p';
  var peers = {};                 // id -> connection
  var listener = null;
  var hooks = {};                 // message prefix -> the module that handles those messages (keo-call.js: 'call', keo-dm.js: 'dm'); see attach
  // How the last connection to each PROVEN peer ended: DID -> { at, why, lost }. Kept in this page's memory only (so it ends with
  // the page and with the session, see closeAll) and read by status() for the toolbar popup. A connection that closed before its
  // peer had proven who it is has no DID and leaves no record.
  var ended = {};
  // When a friend's "last seen" was last written (DID -> ms), so a long connection writes once a minute and not every tick.
  var seenWrote = {}, SEEN_EVERY_MS = 60000;

  function emit(ev) { if (listener) { try { listener(ev); } catch (e) {} } }
  function newId() { return kd.b64u(crypto.getRandomValues(new Uint8Array(9))); }
  function now() { return Date.now(); }

  // ---- why a connection ended ---------------------------------------------------------------------------------------
  // A closed connection gives one sentence, which says what this page noticed, not what led to it. This keeps a short record of the
  // lead-up (states of the peer connection and the channel, the kind of network path, what the page itself went through), in memory
  // and in localStorage so that it can still be read after the page was reloaded or discarded. keoP2p.diag() returns it as text.
  // It holds states, times and kinds of path ("host/udp/wifi"); never addresses, codes, keys or message contents. A second shell tab
  // would overwrite this one's record. It is a diagnostic: nothing decides anything from it.
  var LOG_KEY = 'keo.p2p.log', LOG_MAX = 300, TICK_MS = 5000, STALL_MS = 15000;
  var logEntries = [], lastTick = now();
  try { logEntries = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); if (!Array.isArray(logEntries)) logEntries = []; } catch (e) { logEntries = []; }
  function note(c, what, detail) {
    logEntries.push({ t: now(), c: c ? c.id.slice(0, 4) : '-', e: String(what), d: detail == null ? '' : String(detail).slice(0, 240) });
    if (logEntries.length > LOG_MAX) logEntries.splice(0, logEntries.length - LOG_MAX);
    try { localStorage.setItem(LOG_KEY, JSON.stringify(logEntries)); } catch (e) {}
  }
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function diag() {
    return logEntries.map(function (x) {
      var d = new Date(Number(x.t));
      return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2) + '.' + pad(d.getMilliseconds(), 3) + ' ' + String(x.c) + ' ' + String(x.e) + (x.d ? ' ' + String(x.d) : '');
    }).join('\n');
  }
  // The last look at a connection's path, taken every TICK_MS, so that a close can say how it was doing just before. Not at the
  // moment of closing: getStats on a connection that is going away is not reliable.
  function sample(c) {
    if (c.state === 'closed' || c.sampling) return;
    c.sampling = true;
    c.pc.getStats().then(function (rep) {
      c.sampling = false;
      var byId = {}, pair = null, s = { at: now() };
      rep.forEach(function (r) { byId[r.id] = r; });
      rep.forEach(function (r) { if (r.type === 'transport' && r.selectedCandidatePairId) pair = byId[r.selectedCandidatePairId] || pair; });
      if (pair) {
        var l = byId[pair.localCandidateId], r2 = byId[pair.remoteCandidateId];
        s.path = (l ? l.candidateType + '/' + l.protocol + (l.networkType ? '/' + l.networkType : '') : '?') + ' to ' + (r2 ? r2.candidateType + '/' + r2.protocol : '?');
        s.rtt = pair.currentRoundTripTime; s.recv = pair.bytesReceived; s.req = pair.requestsSent; s.resp = pair.responsesReceived;
      }
      c.last = s;
      if (s.path && s.path !== c.path) { c.path = s.path; note(c, 'path', s.path); }
    }, function () { c.sampling = false; });
  }
  function lastWord(c) {
    var s = c.last, bits = [];
    if (s) bits.push((s.path || 'no path') + (typeof s.rtt === 'number' ? ', rtt ' + Math.round(s.rtt * 1000) + ' ms' : '') + (s.req != null ? ', checks answered ' + s.resp + '/' + s.req : '') + ', sampled ' + Math.round((now() - s.at) / 1000) + ' s ago');
    else bits.push('never sampled');
    bits.push(c.lastRx ? 'last message ' + Math.round((now() - c.lastRx) / 1000) + ' s ago' : 'no message received');
    bits.push('pc ' + c.pc.connectionState + ', ice ' + c.pc.iceConnectionState + ', channel ' + (c.dc ? c.dc.readyState : 'none') + ', page ' + document.visibilityState);
    return bits.join('; ');
  }
  function tick() {
    var t = now();
    if (t - lastTick > STALL_MS) note(null, 'late', 'this page ran ' + Math.round((t - lastTick - TICK_MS) / 1000) + ' s late (the system slept, or the page was in the background); page ' + document.visibilityState);
    lastTick = t;
    Object.keys(peers).forEach(function (k) { sample(peers[k]); noteSeen(peers[k]); });
  }
  setInterval(tick, TICK_MS);
  [[document, 'visibilitychange'], [document, 'freeze'], [document, 'resume'], [window, 'pagehide'], [window, 'pageshow'], [window, 'online'], [window, 'offline']].forEach(function (p) {
    p[0].addEventListener(p[1], function (e) {
      note(null, p[1], p[1] === 'visibilitychange' ? document.visibilityState : p[1] === 'pagehide' ? Object.keys(peers).length + ' connection(s) open, persisted ' + !!(e && e.persisted) : '');
    });
  });
  (function () {
    var prev = logEntries.length ? logEntries[logEntries.length - 1] : null;
    note(null, 'page-load', prev && prev.e !== 'pagehide' ? 'the page before this one ended without a pagehide (crash, discarded tab or power loss), after: ' + prev.e : '');
  })();

  // A received name is shown and used for the download: no path, no control or direction-changing characters.
  function cleanName(s) {
    s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩\\\/:*?"<>|]/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 128);
    return s || 'file';
  }

  function gathered(pc) {
    return new Promise(function (res) {
      if (pc.iceGatheringState === 'complete') return res();
      var t = setTimeout(done, GATHER_MS);       // what has been found by then is used: a slow interface must not hang the invitation
      function done() { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', on); res(); }
      function on() { if (pc.iceGatheringState === 'complete') done(); }
      pc.addEventListener('icegatheringstatechange', on);
    });
  }

  // Have WE added this device (the person checked its words)? Only meaningful once the peer has proven who it is.
  function addedOf(c) { return !!(c.peerOk && c.peer && window.keoContacts.isAdded(c.peer.did)); }
  function view(c) {
    return { id: c.id, role: c.role, state: c.state, peer: c.peer, friend: !!c.friend, added: addedOf(c), theirs: !!c.theirs,
      incoming: Object.keys(c.in).map(function (k) { var i = c.in[k]; return { fid: i.fid, name: i.name, size: i.size, got: i.got, state: i.state }; }),
      outgoing: Object.keys(c.out).map(function (k) { var o = c.out[k]; return { fid: o.fid, name: o.name, size: o.size, sent: o.sent, state: o.state }; }) };
  }
  function setState(c, state, why) {
    if (c.state === state) return;
    c.state = state;
    var ev = { type: 'state', id: c.id, state: state, peer: c.peer, friend: !!c.friend, added: addedOf(c), theirs: !!c.theirs };
    if (why) ev.why = why;
    emit(ev);
  }
  // lost: the connection ended because the path or the other end went away, not because of anything decided or detected here (a
  // violation, a friendship that ended, a timeout, a close asked for here). A module that is waiting for a person is told, so that
  // it can keep what the person is doing (keo-friend.js keeps its dialog).
  // A ready connection to a friend is the friend's "last seen" (keo-contacts.js): written at most once a minute while it lasts, and
  // again when it ends. `force` skips the once-a-minute limit.
  function noteSeen(c, force) {
    if (c.state !== 'ready' || !c.friend || !c.peer) return;
    var t = now(), did = c.peer.did;
    if (!force && seenWrote[did] && t - seenWrote[did] < SEEN_EVERY_MS) return;
    seenWrote[did] = t;
    window.keoContacts.seen(did, t);
  }
  function closeConn(c, why, lost) {
    if (c.state === 'closed') return;
    noteSeen(c, true);
    note(c, 'closed', (why || '(no reason)') + (lost ? ' [lost]' : '') + ' | ' + lastWord(c));
    // Recorded against the proven peer, or against the friend an addressed offer was for (a reconnect that failed or was given up)
    var who = c.peerOk && c.peer ? c.peer.did : c.expect;
    if (who) ended[who] = { at: now(), why: String(why || '').slice(0, 200), lost: !!lost };
    Object.keys(hooks).forEach(function (k) { try { hooks[k].closed(handleOf(c), why, !!lost); } catch (e) {} });
    c.timers.forEach(clearTimeout);
    c.timers = [];
    try { if (c.dc) c.dc.close(); } catch (e) {}
    try { c.pc.close(); } catch (e) {}
    c.in = {}; c.out = {}; c.held = null;
    delete peers[c.id];
    setState(c, 'closed', why);
  }
  function makeConn(role, name, expect) {
    var c = { id: newId(), role: role, expect: expect, pc: new RTCPeerConnection({ iceServers: [] }), dc: null, state: 'new', peer: null, in: {}, out: {}, nextFid: 1, timers: [],
      myName: name ? String(name) : null, offerFp: null, offerTag: null, fps: null,
      hiSent: false, peerOk: false, held: null };
    peers[c.id] = c;
    note(c, 'created', role);
    c.pc.addEventListener('connectionstatechange', function () {
      note(c, 'pc', c.pc.connectionState);
      if (c.pc.connectionState === 'connected') sample(c);
      if (c.pc.connectionState === 'failed') closeConn(c, 'The connection failed.', true);
    });
    c.pc.addEventListener('iceconnectionstatechange', function () { note(c, 'ice', c.pc.iceConnectionState); });
    c.pc.addEventListener('signalingstatechange', function () { note(c, 'signaling', c.pc.signalingState); });
    return c;
  }
  // ms: how long the channel may take to open. The answering side starts waiting before the other person has pasted its code, so it
  // is given as long as an invitation lives.
  function armOpen(c, ms) {
    c.timers.push(setTimeout(function () { if (c.state !== 'open' && c.state !== 'ready') closeConn(c, 'The connection did not open. Both devices need a direct network path to each other.'); }, ms));
  }
  function needSession() {
    return ident.current().then(function (s) { if (!s) throw new Error('Sign in to connect.'); return s; });
  }

  // ---- making a connection ------------------------------------------------------------------------------------------
  // An addressed connection (a reconnect to a friend) names the identity it is FOR. The codes name nobody, so this is the only place
  // that can be said: when the peer's proof is checked and it is a different identity, the connection is closed at once. Asking for
  // it can only narrow who may connect, which is why the world may ask (p2p.offer).
  function expectOf(v) {
    if (v === undefined || v === null || v === '') return null;
    v = String(v);
    if (!/^did:keo:[^\s]{1,190}$/.test(v)) throw new Error('That is not a valid device identity.');
    return v;
  }
  // Side 1: an invitation. Resolves { id, code }; the code goes to the other person.
  async function offer(args) {
    args = args || {};
    await needSession();
    var c = makeConn('offerer', args.name, expectOf(args.expect));
    try {
      c.dc = c.pc.createDataChannel(LABEL);
      wireChannel(c, c.dc);
      await c.pc.setLocalDescription(await c.pc.createOffer());
      await gathered(c.pc);
      var mine = hello.fromSdp(c.pc.localDescription.sdp, 'offer');
      c.offerFp = mine.f;
      c.offerTag = await hello.offerTag(mine);
      var code = await hello.encodeCode(mine);
      setState(c, 'invited');
      c.timers.push(setTimeout(function () { if (c.state === 'invited') closeConn(c, 'Nobody answered the invitation in time.'); }, hello.MAX_AGE_MS));
      return { id: c.id, code: code };
    } catch (e) { closeConn(c); throw e; }
  }
  // Side 2: takes an invitation, resolves { id, code }; the code goes back to side 1. The connection opens on its own once side 1
  // has pasted it, and the 'state' events then say who is there.
  async function answer(args) {
    await needSession();
    var d = await hello.decodeCode(args.code, { role: 'offer' });
    var c = makeConn('answerer', args.name, expectOf(args.expect));
    try {
      c.pc.ondatachannel = function (e) {
        if (e.channel.label !== LABEL || c.dc) { try { e.channel.close(); } catch (x) {} return; }
        c.dc = e.channel;
        wireChannel(c, c.dc);
      };
      await c.pc.setRemoteDescription({ type: 'offer', sdp: hello.codeSdp(d) });
      await c.pc.setLocalDescription(await c.pc.createAnswer());
      await gathered(c.pc);
      var mine = hello.fromSdp(c.pc.localDescription.sdp, 'answer', { tag: await hello.offerTag(d) });
      c.fps = [d.f, mine.f];
      var code = await hello.encodeCode(mine);
      setState(c, 'connecting');
      armOpen(c, hello.MAX_AGE_MS);
      return { id: c.id, code: code };
    } catch (e) { closeConn(c); throw e; }
  }
  // Side 1 again: the answer to its invitation. Resolves { id } once the answer is taken; the channel opens afterwards and the
  // 'state' events say when, and who is there.
  async function finish(args) {
    var c = peers[String(args.id)];
    if (!c || c.role !== 'offerer' || c.state !== 'invited' || c.finishing) throw new Error('There is no open invitation with that id.');
    c.finishing = true;
    try {
      var d = await hello.decodeCode(args.code, { role: 'answer' });
      if (d.tag !== c.offerTag) throw new Error('This answer is not for the invitation that was made here.');
      c.fps = [c.offerFp, d.f];
      await c.pc.setRemoteDescription({ type: 'answer', sdp: hello.codeSdp(d) });
      setState(c, 'connecting');
      armOpen(c, OPEN_MS);
      return { id: c.id };
    } catch (e) { c.finishing = false; throw e; }
  }

  function wireChannel(c, dc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onopen = function () { note(c, 'channel', 'open'); opened(c); };
    dc.onclose = function () { note(c, 'channel', 'close'); closeConn(c, 'The other side closed the connection.', true); };
    dc.onerror = function (e) { note(c, 'channel', 'error ' + (e && e.error && e.error.message || '')); };
    dc.onmessage = function (e) { try { onMessage(c, e.data); } catch (x) { closeConn(c, 'A message could not be handled: ' + (x && x.message)); } };
    if (dc.readyState === 'open') opened(c);
  }

  // ---- proving who is there -----------------------------------------------------------------------------------------
  // The channel is up. From here the peer has to prove itself within PROOF_MS, and we send our own proof first of all.
  function opened(c) {
    if (c.state === 'closed' || c.state === 'open' || c.state === 'ready') return;
    setState(c, 'open');
    c.timers.push(setTimeout(function () { if (c.state !== 'ready') closeConn(c, 'The other side did not prove who it is.'); }, PROOF_MS));
    sendProof(c).then(function () { c.hiSent = true; maybeReady(c); }, function (e) { closeConn(c, 'Could not prove who we are: ' + (e && e.message)); });
  }
  async function sendProof(c) {
    var proof = await ident.deviceProof();
    var h = hello.proofBuild(c.role === 'offerer' ? 'offer' : 'answer', c.fps, proof, { name: c.myName });
    var sig = await ident.signWithDevice(hello.signedBytes(h), proof.did);
    if (c.state === 'closed') return;
    c.dc.send(JSON.stringify({ t: 'hi', hello: h, sig: sig }));
  }
  // Their proof arrived. Messages that come behind it while it is being checked wait their turn (c.held), so a file offer sent right
  // after the proof is not mistaken for one sent before it.
  function gotProof(c, m) {
    if (c.peerOk || c.held) return violation(c, 'a second proof');
    c.held = [];
    hello.verifyProof(m, { role: c.role === 'offerer' ? 'answer' : 'offer', fps: c.fps, audience: location.origin }).then(function (v) {
      if (c.state === 'closed') return;
      if (!v.ok) return closeConn(c, v.error);
      if (c.expect && v.did !== c.expect) return closeConn(c, 'The device that connected is not the one this connection was made for: it proved a different identity.');
      // Who is a friend is read before anything else is accepted, so that the first message already meets the right answer.
      return window.keoContacts.ensure().then(function () {
        if (c.state === 'closed') return;
        c.peer = { did: v.did, name: v.name };
        c.peerOk = true;
        c.theirs = false; c.friend = false;           // learned from the peer's own word on this connection (keo-friend.js)
        maybeReady(c);
        release(c);
      });
    }).catch(function (e) { closeConn(c, 'Could not check who is a friend: ' + (e && e.message)); });
  }
  // Handles what was held back while the proof was being checked, in the order it arrived.
  function release(c) {
    var queued = c.held; c.held = null;
    if (!queued) return;
    queued.forEach(function (d) { if (c.state !== 'closed') { try { onMessage(c, d); } catch (x) { closeConn(c, 'A message could not be handled: ' + (x && x.message)); } } });
  }
  function maybeReady(c) {
    if (c.state === 'open' && c.peerOk && c.hiSent) {
      c.readyAt = now();
      setState(c, 'ready');
      // Modules that have something to say as soon as the peer is proven (keo-friend.js: whether we have added it) are told here.
      Object.keys(hooks).forEach(function (k) { if (hooks[k].ready) { try { hooks[k].ready(handleOf(c)); } catch (e) {} } });
    }
  }

  // ---- the protocol -------------------------------------------------------------------------------------------------
  function violation(c, what) { closeConn(c, 'The other side broke the protocol (' + what + ').'); }
  function sendCtl(c, m) { c.dc.send(JSON.stringify(m)); }

  function onMessage(c, data) {
    c.lastRx = now();
    if (c.held) { c.held.push(data); return; }                 // behind a proof that is being checked
    if (typeof data === 'string') {
      if (data.length > MAX_PROOF) return violation(c, 'oversized message');
      var m;
      try { m = JSON.parse(data); } catch (e) { return violation(c, 'not JSON'); }
      if (!m || typeof m !== 'object') return violation(c, 'bad message');
      if (m.t === 'hi') return gotProof(c, m);
      // A message of an attached module ('call.*', 'dm.*') may be longer than a file message (a call carries a session description);
      // the overall cap above still applies. It is handed over only once the peer has proven who it is.
      var dot = typeof m.t === 'string' ? m.t.indexOf('.') : -1;
      if (dot > 0 && Object.prototype.hasOwnProperty.call(hooks, m.t.slice(0, dot))) {
        if (!c.peerOk) return violation(c, 'a message before the proof');
        var hook = hooks[m.t.slice(0, dot)];
        // Only the module that settles friendship may be spoken to by someone who is not a friend; everything else (calls, messages)
        // is for friends. A device that is not one has nothing to say but "I added you" and "I removed you".
        if (!c.friend && !hook.open) return violation(c, 'a message from someone who is not a friend');
        return hook.message(handleOf(c), m);
      }
      if (data.length > MAX_CONTROL) return violation(c, 'oversized message');
      if (!c.peerOk) return violation(c, 'a message before the proof');
      if (!c.friend) return violation(c, 'a file message from someone who is not a friend');
      if (!Number.isSafeInteger(m.fid) || m.fid < 1 || m.fid > 0xffffffff) return violation(c, 'bad message');
      return control(c, m);
    }
    if (!c.peerOk) return violation(c, 'data before the proof');
    if (!c.friend) return violation(c, 'file data from someone who is not a friend');
    if (data instanceof ArrayBuffer) return chunk(c, data);
    violation(c, 'unknown message kind');
  }

  function control(c, m) {
    var i = c.in[m.fid], o = c.out[m.fid];
    if (m.t === 'file') {
      if (i || !Number.isSafeInteger(m.size) || m.size < 0 || m.size > MAX_FILE || typeof m.name !== 'string') return violation(c, 'bad file offer');
      var asked = Object.keys(c.in).filter(function (k) { return c.in[k].state === 'asked'; }).length;
      if (asked >= MAX_ASKED) return sendCtl(c, { t: 'no', fid: m.fid });
      c.in[m.fid] = { fid: m.fid, name: cleanName(m.name), size: m.size, got: 0, parts: [], state: 'asked', lastEmit: 0 };
      return emit({ type: 'incoming', dir: 'in', id: c.id, peer: c.peer, fid: m.fid, name: c.in[m.fid].name, size: m.size });
    }
    if (m.t === 'go') {
      if (!o || o.state !== 'offered') return violation(c, 'unexpected go');
      o.state = 'sending';
      return pump(c, o);
    }
    if (m.t === 'no') {
      if (!o || o.state !== 'offered') return violation(c, 'unexpected no');
      delete c.out[m.fid];
      return emit({ type: 'declined', dir: 'out', id: c.id, fid: m.fid, name: o.name });
    }
    if (m.t === 'done') {
      if (!i || i.state !== 'receiving') return violation(c, 'unexpected done');
      if (i.got !== i.size) { delete c.in[m.fid]; sendCtl(c, { t: 'cancel', fid: m.fid }); return emit({ type: 'failed', dir: 'in', id: c.id, fid: m.fid, name: i.name, why: 'The file ended before its announced size.' }); }
      i.blob = new Blob(i.parts, { type: 'application/octet-stream' });
      i.parts = null;
      i.state = 'received';
      sendCtl(c, { t: 'ok', fid: m.fid });
      return emit({ type: 'received', dir: 'in', id: c.id, fid: m.fid, name: i.name, size: i.size });
    }
    if (m.t === 'ok') {
      if (!o || o.state !== 'awaiting') return violation(c, 'unexpected ok');
      delete c.out[m.fid];
      return emit({ type: 'delivered', dir: 'out', id: c.id, fid: m.fid, name: o.name, size: o.size });
    }
    if (m.t === 'cancel') {
      if (o) { o.state = 'cancelled'; delete c.out[m.fid]; return emit({ type: 'cancelled', dir: 'out', id: c.id, fid: m.fid, name: o.name }); }
      if (i) { delete c.in[m.fid]; return emit({ type: 'cancelled', dir: 'in', id: c.id, fid: m.fid, name: i.name }); }
      return;           // a cancel that crossed our own: nothing left to cancel
    }
    violation(c, 'unknown message');
  }

  function chunk(c, buf) {
    if (buf.byteLength <= 4) return violation(c, 'empty chunk');
    var fid = new DataView(buf).getUint32(0), i = c.in[fid];
    if (!i || i.state !== 'receiving') return;       // for a file already cancelled or never agreed to
    var payload = buf.slice(4);
    i.got += payload.byteLength;
    if (i.got > i.size) {
      delete c.in[fid];
      sendCtl(c, { t: 'cancel', fid: fid });
      return emit({ type: 'failed', dir: 'in', id: c.id, fid: fid, name: i.name, why: 'The peer sent more than it announced.' });
    }
    i.parts.push(payload);
    progress(c, i, 'in', i.got);
  }

  function progress(c, f, dir, done) {
    var t = now();
    if (done < f.size && t - f.lastEmit < 200) return;
    f.lastEmit = t;
    emit({ type: 'progress', id: c.id, fid: f.fid, dir: dir, name: f.name, done: done, total: f.size });
  }

  // Waits until the channel's send buffer has room. The timer re-checks the state, so a channel that closed while waiting does
  // not leave the sender waiting for an event that will not come.
  async function drain(c) {
    while (c.state === 'ready' && c.dc.bufferedAmount > HIGH_WATER) {
      await new Promise(function (res) {
        var t = setTimeout(res, 1000);
        c.dc.addEventListener('bufferedamountlow', function () { clearTimeout(t); res(); }, { once: true });
      });
    }
  }
  async function pump(c, o) {
    try {
      for (var off = 0; off < o.size; off += CHUNK) {
        if (o.state !== 'sending' || c.state !== 'ready') return;
        var buf = await o.file.slice(off, Math.min(off + CHUNK, o.size)).arrayBuffer();
        await drain(c);
        if (o.state !== 'sending' || c.state !== 'ready') return;
        var frame = new Uint8Array(4 + buf.byteLength);
        new DataView(frame.buffer).setUint32(0, o.fid);
        frame.set(new Uint8Array(buf), 4);
        c.dc.send(frame);
        o.sent = off + buf.byteLength;
        progress(c, o, 'out', o.sent);
      }
      if (o.state !== 'sending' || c.state !== 'ready') return;
      o.state = 'awaiting';
      o.sent = o.size;
      progress(c, o, 'out', o.size);
      sendCtl(c, { t: 'done', fid: o.fid });
    } catch (e) {
      delete c.out[o.fid];
      emit({ type: 'failed', dir: 'out', id: c.id, fid: o.fid, name: o.name, why: 'Sending stopped: ' + (e && e.message) });
      if (c.state === 'ready') { try { sendCtl(c, { t: 'cancel', fid: o.fid }); } catch (x) {} }
    }
  }

  // ---- what the world may ask ---------------------------------------------------------------------------------------
  function ready(id) {
    var c = peers[String(id)];
    if (!c || c.state !== 'ready') throw new Error('That connection is not ready.');
    return c;
  }
  // Offers a file. `file` is a Blob or File the world holds (a structured clone shares the bytes, it does not copy them). The
  // bytes flow only after the other side agrees.
  function send(args) {
    var c = ready(args.id), f = args.file;
    if (!c.friend) throw new Error('You can only share files with a friend.');
    if (!(f instanceof Blob)) throw new Error('send: a file is needed.');
    if (f.size > MAX_FILE) throw new Error('That file is larger than the limit (' + Math.round(MAX_FILE / 1048576) + ' MiB).');
    if (Object.keys(c.out).length >= MAX_OFFERED) throw new Error('Too many files are waiting. Let some finish first.');
    var o = { fid: c.nextFid++, file: f, name: String(args.name || f.name || 'file').slice(0, 256), size: f.size, sent: 0, state: 'offered', lastEmit: 0 };
    c.out[o.fid] = o;
    sendCtl(c, { t: 'file', fid: o.fid, name: o.name, size: o.size });
    return { fid: o.fid };
  }
  // Answers an incoming offer. The bytes start to arrive only after a yes.
  function respond(args) {
    var c = ready(args.id), i = c.in[args.fid];
    if (!i || i.state !== 'asked') throw new Error('That offer is not waiting for an answer.');
    if (args.accept === true) { i.state = 'receiving'; sendCtl(c, { t: 'go', fid: i.fid }); }
    else { delete c.in[i.fid]; sendCtl(c, { t: 'no', fid: i.fid }); }
    return true;
  }
  // Stops a transfer from either side.
  function cancel(args) {
    var c = ready(args.id), fid = args.fid;
    if (!c.in[fid] && !c.out[fid]) throw new Error('There is no such transfer.');
    delete c.in[fid]; delete c.out[fid];
    sendCtl(c, { t: 'cancel', fid: fid });
    return true;
  }
  // Hands a received file to the browser's download. The page's own link does it, so the sandboxed world, which may not start a
  // download, does not need to and never holds the bytes.
  function save(args) {
    var c = peers[String(args.id)], i = c && c.in[args.fid];
    if (!i || i.state !== 'received') throw new Error('That file has not been received.');
    var url = URL.createObjectURL(i.blob), a = document.createElement('a');
    a.href = url; a.download = i.name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    delete c.in[i.fid];
    emit({ type: 'saved', dir: 'in', id: c.id, fid: i.fid, name: i.name, size: i.size });
    return true;
  }
  function close(args) {
    var c = peers[String(args.id)];
    if (c) closeConn(c, 'Closed here.');
    return true;
  }
  function list() { return Object.keys(peers).map(function (k) { return view(peers[k]); }); }
  // Gives up the reconnects under way to one friend (not the live connection, if there is one).
  function cancelFor(did) {
    Object.keys(peers).forEach(function (k) { var c = peers[k]; if (!c.peerOk && c.expect === did) closeConn(c, 'Closed here.'); });
    return true;
  }
  // Only for the end of a session: what it knew about how connections ended goes with it.
  function closeAll() { Object.keys(peers).forEach(function (k) { closeConn(peers[k], 'Closed here.'); }); ended = {}; seenWrote = {}; }
  // Plain data for the toolbar popup (keo-status.js): every connection whose peer has proven who it is, and how the last one to each
  // peer ended. 'connected' is a friend on a ready connection; 'unconfirmed' is ready but not (yet) a friend either way round.
  function status() {
    return {
      connections: Object.keys(peers).map(function (k) { return peers[k]; }).filter(function (c) { return (c.peerOk && c.peer) || c.expect; }).map(function (c) {
        // An addressed connection whose peer has not proven itself yet is a reconnect under way: 'invited' while it waits for the other
        // side's code, then 'connecting'.
        if (!c.peerOk) return { did: c.expect, state: 'reconnecting', waiting: c.state === 'invited', since: null };
        return { did: c.peer.did, state: c.state === 'ready' ? (c.friend ? 'connected' : 'unconfirmed') : 'connecting', since: c.readyAt || null };
      }),
      ended: JSON.parse(JSON.stringify(ended))
    };
  }

  // ---- for keo-call.js (this page only) -------------------------------------------------------------------------------
  // What a call needs of a connection: the peer connection to add media to, the two DTLS fingerprints the proof was made over,
  // the verified peer, and a way to send a message on the proven channel. It is handed out only for a connection that is
  // `ready`, and it is NOT reachable from the world (no bridge op returns it). `peerFp` is the other side's fingerprint, the
  // one a received session description has to carry.
  function handleOf(c) {
    if (!c.handle) {
      c.handle = { id: c.id, pc: c.pc, role: c.role, fps: c.fps,
        peerFp: c.fps ? String(c.fps[c.role === 'offerer' ? 1 : 0]).toUpperCase() : null,
        get peer() { return c.peer; },
        get friend() { return !!c.friend; },
        get theirs() { return !!c.theirs; },
        ready: function () { return c.state === 'ready'; },
        send: function (m) { if (c.state !== 'ready') throw new Error('That connection is not ready.'); sendCtl(c, m); },
        drop: function (why) { closeConn(c, why); } };
    }
    return c.handle;
  }
  function handle(id) { return handleOf(ready(id)); }
  // A module takes the messages whose type starts with `<prefix>.`: attach('call', { message(handle, m), closed(handle, why, lost) }).
  // `message` gets each one from a peer that has proven itself AND is a friend (a message from anyone else closes the connection);
  // if it throws, the connection is closed like for any message that cannot be handled. `ready(handle)`, if given, is called when a
  // connection becomes ready. `closed` is told when any connection ends. One module per prefix, and the file protocol's own types (file, go,
  // no, done, ok, cancel) have no dot, so a module cannot take those. `open: true` (only keo-friend.js) also takes messages from a
  // peer that is not a friend yet: that is how two devices become friends.
  function attach(prefix, ext, opts) {
    if (!/^[a-z]+$/.test(prefix) || hooks[prefix]) throw new Error('keo-p2p: bad or taken prefix ' + prefix);
    hooks[prefix] = ext;
    if (opts && opts.open === true) ext.open = true;
  }

  // For keo-friend.js (this page only). A connection's peer is a FRIEND while we have added it (the book) AND it has told us, on this
  // connection, that it has added us. Either half changing re-decides it: becoming one is announced to the world; ceasing to be one
  // closes the connection, which also ends a call on it and stops the camera and microphone. Never put these behind a bridge op.
  function recompute(c) {
    if (c.state === 'closed' || !c.peerOk) return;
    var now = !!(c.theirs && addedOf(c));
    var was = !!c.friend;
    c.friend = now;
    if (was && !now) return closeConn(c, 'You are no longer friends.');
    if (now && !was) noteSeen(c);
    // Not a 'state' event: the connection's state did not change, and a world that counts states must not see 'ready' twice.
    emit({ type: 'friendship', id: c.id, peer: c.peer, friend: now, added: addedOf(c), theirs: !!c.theirs });
  }
  // The peer on this connection said whether it has added us.
  function setTheirs(id, value) {
    var c = peers[String(id)];
    if (!c || !c.peerOk) return;
    c.theirs = value === true;
    recompute(c);
  }
  // The book changed for this DID: every connection to it is re-decided.
  function friendChanged(did) {
    Object.keys(peers).forEach(function (k) { var c = peers[k]; if (c.peerOk && c.peer && c.peer.did === did) recompute(c); });
  }
  // Handles of the connections to one DID that are ready (to tell them something).
  function connectionsTo(did) {
    return Object.keys(peers).map(function (k) { return peers[k]; }).filter(function (c) { return c.state === 'ready' && c.peer && c.peer.did === did; }).map(function (c) { return handleOf(c); });
  }

  window.keoP2p = { offer: offer, answer: answer, finish: finish, send: send, respond: respond, cancel: cancel, save: save,
    close: close, list: list, closeAll: closeAll, cancelFor: cancelFor, status: status, diag: diag, cleanName: cleanName, handle: handle, attach: attach, friendChanged: friendChanged, setTheirs: setTheirs, connectionsTo: connectionsTo,
    // one listener, for the bridge: events are plain data
    onEvent: function (fn) { listener = fn; } };
})();
