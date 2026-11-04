// keo calls (camera and microphone), SHELL side. Runs in the extension's own page, like the connections it adds media to
// (keo-p2p.js). Only this page can capture, and the sandboxed world is not trusted, so the world gets a way to ASK for a call and
// plain-data events about it, and nothing else: it never holds a stream, never says where anything is drawn, and cannot answer
// for the person.
//
// The rules (the world is assumed hostile):
//  - Capture starts only after the person clicks in the call panel, which is drawn by THIS page, outside the world's frame:
//    "Video call" / "Audio call" for a call they make, "Accept" / "Audio only" for one that comes in. A request from the world
//    (call.start) only raises that panel. The world has no op that accepts, answers or places a call for the person.
//  - The panel is positioned and sized by this page; no bridge op moves, resizes, hides or styles it, and while a call is in
//    progress it stays up with the other party's name, picture and short DID, a mute, a camera switch and a hang-up.
//    (start.html keeps it below the identity vault's unlock frame, which must never be covered.)
//  - The world gets text events only (state, who, whether video is on); the stream stays in this page.
//  - The world may lower what is captured (mute, camera off: call.lower) and never raise it.
//  - A request from the world is refused while a call is under way, and for a few seconds after the person dismissed a prompt, so
//    it cannot keep putting a prompt in front of them.
// A hostile world can still DRAW something that looks like this panel inside its own frame. Its clicks never reach this page, so
// it cannot grant anything, but it can mislead: that is why the panel shows who is at the other end by the identity that was
// proven over the channel (name the peer chose, picture and short DID of that DID), not by anything the world supplies.
//
// How a call runs, over the proven data channel (messages `call.*`, routed here by keo-p2p.js once the peer has proven itself):
//   caller: click -> capture -> call.ring {cid, video}          callee: panel shows it; click -> capture -> call.accept {cid, video}
//   caller: call.sdp offer (media added to the SAME connection by renegotiating; no new codes are swapped)
//   callee: call.sdp answer. call.decline / call.end either way at any time.
// Every description received is checked first (keo-callsdp.js: the fingerprints must be the proven peer's, the media bundled
// onto the existing transport, the credentials unchanged). One call at a time on this page; the media sections stay on the
// connection after a call (the tracks are taken off), so a second call reuses them.
// Not done: calls of more than two, adding the camera to a call that began with audio only, sound level / quality display, a
// second call while one is going (the other is told "busy"), a ring that survives the world or the page restarting.
(function () {
  'use strict';
  var p2p = window.keoP2p, sdpCheck = window.keoCallSdp, icons = window.keoIdenticon, kd = window.keoDid;
  var RING_MS = 45000, PROMPT_MS = 60000, CONNECT_MS = 25000, RERING_MS = 5000, DISMISS_MS = 10000;
  var CID = /^[A-Za-z0-9_-]{8,24}$/;
  var call = null;                  // the one call at a time
  var listener = null, lastDismissed = 0, lastRing = 0;
  var ui = null;                    // the panel's elements, built on first use

  function newCid() { return kd.b64u(crypto.getRandomValues(new Uint8Array(9))); }
  function shortDid(did) {
    var m = /^did:keo:[^:]+:([A-Za-z0-9_-]{43})$/.exec(String(did));
    return m ? 'keo:' + m[1].slice(0, 4) + '…' + m[1].slice(-4) : String(did).slice(0, 24);
  }
  function peerView(c) { var p = c.h.peer; return p ? { did: p.did, name: p.name || null } : null; }

  // ---- what the world is told -----------------------------------------------------------------------------------------
  function view(c) {
    return { type: 'call', id: c.h.id, cid: c.cid, state: c.state, dir: c.dir, peer: peerView(c), video: !!c.video, wantsVideo: !!c.wantsVideo,
      mic: c.local ? c.mic : false, cam: !!c.cam, remoteVideo: remoteVideoLive(c) };
  }
  function emit(c, why) {
    if (!listener) return;
    var ev = view(c);
    if (why) ev.why = String(why).slice(0, 200);
    try { listener(ev); } catch (e) {}
  }

  // ---- the panel ------------------------------------------------------------------------------------------------------
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function build() {
    if (ui) return ui;
    var root = el('div'); root.id = 'keo-call'; root.hidden = true;
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Call');
    var head = el('div', 'head'), img = el('img', 'who-img'), who = el('div', 'who'), name = el('div', 'who-name'), did = el('div', 'who-did');
    img.width = img.height = 40; img.alt = '';
    who.appendChild(name); who.appendChild(did); head.appendChild(img); head.appendChild(who);
    var status = el('div', 'status');
    var stage = el('div', 'stage'), remote = el('video', 'remote'), hold = el('img', 'hold'), self = el('video', 'self');
    remote.autoplay = true; remote.playsInline = true;
    self.autoplay = true; self.playsInline = true; self.muted = true;
    hold.alt = '';
    stage.appendChild(remote); stage.appendChild(hold); stage.appendChild(self);
    var note = el('div', 'note'), btns = el('div', 'btns');
    [head, status, stage, note, btns].forEach(function (x) { root.appendChild(x); });
    document.body.appendChild(root);
    // Only a real click counts. Nothing in the world can reach this page's elements, but the check costs nothing.
    root.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest && ev.target.closest('button[data-act]');
      if (!b || !ev.isTrusted) return;
      act(b.getAttribute('data-act'));
    });
    ui = { root: root, img: img, name: name, did: did, status: status, remote: remote, hold: hold, self: self, note: note, btns: btns };
    return ui;
  }
  var LABELS = { 'go-video': 'Video call', 'go-audio': 'Audio call', cancel: 'Cancel', accept: 'Accept', 'accept-audio': 'Audio only', decline: 'Decline',
    hang: 'Hang up', mic: 'Mute', cam: 'Camera off' };
  function buttons(c) {
    if (c.dir === 'out' && c.state === 'confirming') return ['go-video', 'go-audio', 'cancel'];
    if (c.dir === 'out' && (c.state === 'starting' || c.state === 'ringing')) return ['cancel'];
    if (c.dir === 'in' && c.state === 'incoming') return c.wantsVideo ? ['accept', 'accept-audio', 'decline'] : ['accept', 'decline'];
    if (c.state === 'active') return c.video ? ['mic', 'cam', 'hang'] : ['mic', 'hang'];
    return ['hang'];
  }
  function statusText(c) {
    var n = (c.h.peer && c.h.peer.name) || 'this device';
    if (c.dir === 'out' && c.state === 'confirming') return 'Call ' + n + '?';
    if (c.state === 'starting') return 'Starting…';
    if (c.state === 'ringing') return 'Calling…';
    if (c.state === 'incoming') return n + ' is calling' + (c.wantsVideo ? ' (video)' : '');
    if (c.state === 'accepting') return 'Starting…';
    if (c.state === 'connecting') return 'Connecting…';
    return 'In the call';
  }
  function render() {
    var c = call;
    if (!c) { if (ui) { ui.root.hidden = true; ui.remote.srcObject = null; ui.self.srcObject = null; } return; }
    var u = build(), p = c.h.peer;
    // The name is whatever the peer chose to show (text only); the picture and short DID are the proven identity's.
    u.name.textContent = (p && p.name) || 'Unnamed device';
    u.did.textContent = p ? shortDid(p.did) : '';
    u.did.title = p ? p.did : '';
    if (u.shownDid !== (p && p.did)) {
      u.shownDid = p && p.did;
      u.img.src = icons.dataUrl(p ? p.did : '?', 80); u.hold.src = icons.dataUrl(p ? p.did : '?', 160);
    }
    // What is being captured is always said, from the first moment (a camera light may be on while it still rings).
    u.status.textContent = statusText(c) + (c.local ? ' — ' + (c.cam ? 'camera and microphone on' : 'microphone on') : '');
    u.note.textContent = c.noteText || '';
    u.note.hidden = !c.noteText;
    if (u.remote.srcObject !== c.remote) u.remote.srcObject = c.remote || null;
    if (u.self.srcObject !== c.local) u.self.srcObject = c.local || null;
    var live = remoteVideoLive(c);
    u.root.classList.toggle('video', !!c.video && c.state === 'active');
    u.remote.hidden = !live;
    u.hold.hidden = live || !(c.video && c.state === 'active');
    u.self.hidden = !(c.cam && c.local);
    u.btns.textContent = '';
    buttons(c).forEach(function (a) {
      var label = LABELS[a];
      if (a === 'mic' && !c.mic) label = 'Unmute';
      if (a === 'cam' && !c.cam) label = 'Camera on';
      var b = el('button', a, label); b.type = 'button'; b.setAttribute('data-act', a);
      u.btns.appendChild(b);
    });
    u.root.hidden = false;
  }

  // ---- the call's life ------------------------------------------------------------------------------------------------
  function stopStream(s) { if (s) s.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); }
  function timer(c, ms, fn) { c.timers.push(setTimeout(function () { if (call === c) fn(); }, ms)); }
  function newCall(h, dir) {
    return { cid: null, h: h, dir: dir, state: null, timers: [], local: null, remote: null, mic: true, cam: false, video: false, wantsVideo: false,
      offered: false, gotOffer: false, noteText: '', camBusy: false };
  }
  function setState(c, state) { c.state = state; render(); emit(c); }
  function sendTo(c, m) { try { c.h.send(m); } catch (e) {} }

  // Ends the call here. `tell`: also say so to the peer (not when the peer ended it, or the connection is gone).
  function endCall(c, why, tell) {
    if (!c || call !== c) return;
    if (tell && c.cid && c.state !== 'confirming') sendTo(c, { t: 'call.end', cid: c.cid });
    c.timers.forEach(clearTimeout); c.timers = [];
    c.state = 'ended';
    try { c.h.pc.getSenders().forEach(function (s) { if (s.track && s.track.kind && c.local && c.local.getTracks().indexOf(s.track) >= 0) s.replaceTrack(null).catch(function () {}); }); } catch (e) {}
    stopStream(c.local);
    var wasLive = c.local;
    c.local = null; c.cam = false;
    call = null;
    render();
    var ev = view(c); ev.cam = false; ev.mic = false; ev.remoteVideo = false; ev.why = String(why || 'The call ended.').slice(0, 200);
    if (listener) { try { listener(ev); } catch (e) {} }
    return wasLive;
  }

  // Microphone and, if asked, camera. A camera that cannot be used falls back to audio alone, and the panel says so.
  async function capture(c, wantVideo) {
    var md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) throw new Error('This browser cannot reach a microphone or camera.');
    var stream;
    try {
      stream = await md.getUserMedia({ audio: true, video: wantVideo ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } } : false });
    } catch (e) {
      if (!wantVideo) throw e;
      stream = await md.getUserMedia({ audio: true, video: false });
      c.noteText = 'The camera could not be used (' + (e && e.name || 'error') + '): this call is audio only.';
    }
    if (call !== c || c.state === 'ended') { stopStream(stream); throw new Error('The call ended first.'); }
    c.local = stream;
    c.video = stream.getVideoTracks().length > 0;
    c.cam = c.video;
    c.mic = true;
    return stream;
  }
  function failed(c, e) { endCall(c, 'Could not start: ' + (e && e.message || e), true); }

  function act(a) {
    var c = call;
    if (!c) return;
    if (a === 'cancel') {
      if (c.state === 'confirming') lastDismissed = Date.now();
      return endCall(c, c.state === 'confirming' ? 'Dismissed.' : 'Cancelled.', true);
    }
    if (a === 'hang') return endCall(c, 'Hung up.', true);
    if (a === 'decline') { sendTo(c, { t: 'call.decline', cid: c.cid }); return endCall(c, 'Declined.', false); }
    if (a === 'go-video' || a === 'go-audio') return place(c, a === 'go-video');
    if (a === 'accept' || a === 'accept-audio') return take(c, a === 'accept' && c.wantsVideo);
    if (a === 'mic') { c.mic = !c.mic; if (c.local) c.local.getAudioTracks().forEach(function (t) { t.enabled = c.mic; }); render(); return emit(c); }
    if (a === 'cam') return camera(c);
  }

  // ---- placing a call ---------------------------------------------------------------------------------------------------
  // The world asked. This only puts the prompt up; nothing is captured until the person clicks in it.
  function start(args) {
    var h = p2p.handle(args.id);
    if (call) throw new Error('A call is already in progress.');
    if (Date.now() - lastDismissed < DISMISS_MS) throw new Error('A call prompt was dismissed a moment ago.');
    var c = newCall(h, 'out');
    c.cid = newCid();
    call = c;
    setState(c, 'confirming');
    timer(c, PROMPT_MS, function () { lastDismissed = Date.now(); endCall(c, 'The prompt timed out.', false); });
    return { cid: c.cid };
  }
  async function place(c, wantVideo) {
    if (c.state !== 'confirming') return;
    c.timers.forEach(clearTimeout); c.timers = [];
    c.wantsVideo = wantVideo;
    setState(c, 'starting');
    try { await capture(c, wantVideo); } catch (e) { return failed(c, e); }
    if (call !== c || !c.h.ready()) return;
    try { c.h.send({ t: 'call.ring', cid: c.cid, video: c.video }); } catch (e) { return failed(c, e); }
    c.wantsVideo = c.video;
    setState(c, 'ringing');
    timer(c, RING_MS, function () { endCall(c, 'Nobody answered.', true); });
  }

  // ---- taking a call ----------------------------------------------------------------------------------------------------
  async function take(c, video) {
    if (c.state !== 'incoming') return;
    c.timers.forEach(clearTimeout); c.timers = [];
    setState(c, 'accepting');
    try { await capture(c, video); } catch (e) { sendTo(c, { t: 'call.decline', cid: c.cid }); return endCall(c, 'Could not start: ' + (e && e.message || e), false); }
    if (call !== c || !c.h.ready()) return;
    try { c.h.send({ t: 'call.accept', cid: c.cid, video: c.video }); } catch (e) { return failed(c, e); }
    c.video = c.video && c.wantsVideo;
    setState(c, 'connecting');
    timer(c, CONNECT_MS, function () { endCall(c, 'The call did not connect.', true); });
  }

  // ---- media on the connection ------------------------------------------------------------------------------------------
  function mediaTx(pc, kind) {
    var all = pc.getTransceivers();
    for (var i = 0; i < all.length; i++) if (all[i].mid !== null && all[i].receiver && all[i].receiver.track.kind === kind) return all[i];
    return null;
  }
  // Puts the local tracks on the connection: on a media section left from an earlier call when there is one, else a new one.
  function attachLocal(c) {
    var pc = c.h.pc;
    c.local.getTracks().forEach(function (t) {
      var tx = mediaTx(pc, t.kind);
      if (tx) { tx.sender.replaceTrack(t); tx.direction = 'sendrecv'; } else pc.addTrack(t, c.local);
    });
  }
  // The remote side's tracks as one stream for the panel. Read from the receivers, not from `track` events: a second call on the
  // same connection reuses the sections, and no event fires for a receiver that was already there.
  function gatherRemote(c) {
    var s = new MediaStream();
    c.h.pc.getReceivers().forEach(function (r) { if (r.track && (r.track.kind === 'audio' || (r.track.kind === 'video' && c.video))) s.addTrack(r.track); });
    c.remote = s;
    s.getTracks().forEach(function (t) { t.addEventListener('mute', function () { if (call === c) { render(); emit(c); } }); t.addEventListener('unmute', function () { if (call === c) { render(); emit(c); } }); });
  }
  function remoteVideoLive(c) {
    if (!c.remote) return false;
    return c.remote.getVideoTracks().some(function (t) { return !t.muted && t.readyState === 'live'; });
  }
  function active(c) {
    c.timers.forEach(clearTimeout); c.timers = [];
    gatherRemote(c);
    setState(c, 'active');
  }
  async function sendOffer(c) {
    var pc = c.h.pc;
    attachLocal(c);
    await pc.setLocalDescription(await pc.createOffer());
    c.offered = true;
    c.h.send({ t: 'call.sdp', cid: c.cid, type: 'offer', sdp: pc.localDescription.sdp });
  }
  function checked(c, m) {
    var pc = c.h.pc;
    var v = sdpCheck.check(m.sdp, { peerFp: c.h.peerFp, remoteSdp: pc.currentRemoteDescription && pc.currentRemoteDescription.sdp });
    if (!v.ok) { c.h.drop('The other side sent an unusable call description: ' + v.error); return null; }
    // A video section may well be there in an audio-only call: sections stay on the connection after a call. Whether the peer's
    // video is SHOWN is decided by gatherRemote (only in a call set up with video).
    return v;
  }
  async function gotOffer(c, m) {
    var pc = c.h.pc;
    if (!checked(c, m)) return;
    c.gotOffer = true;
    await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
    attachLocal(c);
    await pc.setLocalDescription(await pc.createAnswer());
    c.h.send({ t: 'call.sdp', cid: c.cid, type: 'answer', sdp: pc.localDescription.sdp });
    active(c);
  }
  async function gotAnswer(c, m) {
    if (!checked(c, m)) return;
    await c.h.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
    active(c);
  }
  async function camera(c) {
    if (c.camBusy || c.state !== 'active' || !c.video) return;
    c.camBusy = true;
    try {
      var tx = mediaTx(c.h.pc, 'video');
      if (c.cam) {
        c.local.getVideoTracks().forEach(function (t) { t.stop(); c.local.removeTrack(t); });
        if (tx) await tx.sender.replaceTrack(null);
        c.cam = false;
      } else {
        var s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } } });
        var t = s.getVideoTracks()[0];
        if (call !== c) { stopStream(s); return; }
        c.local.addTrack(t);
        if (tx) await tx.sender.replaceTrack(t);
        c.cam = true;
      }
    } catch (e) { c.noteText = 'The camera could not be switched: ' + (e && e.name || 'error'); }
    c.camBusy = false;
    if (call === c) { render(); emit(c); }
  }

  // ---- what the other side says -----------------------------------------------------------------------------------------
  function bad(what) { throw new Error('a bad call message (' + what + ')'); }
  // `m` is a parsed message from a peer that has proven itself; anything malformed is a protocol violation (the caller closes the
  // connection), anything merely late or out of turn is ignored.
  function message(h, m) {
    if (typeof m.cid !== 'string' || !CID.test(m.cid)) bad('cid');
    var c = call && call.h.id === h.id && call.cid === m.cid ? call : null;
    if (m.t === 'call.ring') {
      if (typeof m.video !== 'boolean') bad('ring');
      if (!h.ready()) return;
      if (call) { if (!c) { try { h.send({ t: 'call.decline', cid: m.cid, why: 'busy' }); } catch (e) {} } return; }
      var now = Date.now();
      if (now - lastRing < RERING_MS) return;                       // a peer that rings again and again gets no panel
      lastRing = now;
      var n = newCall(h, 'in');
      n.cid = m.cid; n.wantsVideo = m.video;
      call = n;
      setState(n, 'incoming');
      timer(n, RING_MS, function () { sendTo(n, { t: 'call.decline', cid: n.cid }); endCall(n, 'Missed.', false); });
      return;
    }
    if (!c) return;                                                 // for a call that is over, or never was here
    if (m.t === 'call.accept') {
      if (typeof m.video !== 'boolean') bad('accept');
      if (c.dir !== 'out' || c.state !== 'ringing') return;
      c.timers.forEach(clearTimeout); c.timers = [];
      if (!m.video && c.local) c.local.getVideoTracks().forEach(function (t) { t.stop(); c.local.removeTrack(t); });
      c.video = c.video && m.video; c.cam = c.video;
      setState(c, 'connecting');
      timer(c, CONNECT_MS, function () { endCall(c, 'The call did not connect.', true); });
      sendOffer(c).catch(function (e) { failed(c, e); });
      return;
    }
    if (m.t === 'call.decline') { if (c.dir === 'out') endCall(c, m.why === 'busy' ? 'The other side is busy.' : 'Declined.', false); return; }
    if (m.t === 'call.end') return void endCall(c, 'The other side ended the call.', false);
    if (m.t === 'call.sdp') {
      if (typeof m.sdp !== 'string' || (m.type !== 'offer' && m.type !== 'answer')) bad('sdp');
      if (m.type === 'offer' && c.dir === 'in' && c.state === 'connecting' && !c.gotOffer) return void gotOffer(c, m).catch(function (e) { failed(c, e); });
      if (m.type === 'answer' && c.dir === 'out' && c.state === 'connecting' && c.offered) return void gotAnswer(c, m).catch(function (e) { failed(c, e); });
      return;
    }
    bad('unknown');
  }
  function closed(h, why) {
    if (call && call.h.id === h.id) endCall(call, why || 'The connection closed.', false);
  }

  // ---- what the world may ask -------------------------------------------------------------------------------------------
  function end(args) {
    if (call && call.h.id === String(args.id)) endCall(call, 'Ended here.', true);
    return true;
  }
  // The world may LOWER what is captured, never raise it: it can mute the microphone or switch the camera off, and nothing here
  // turns either back on (Unmute and Camera on are clicks in the panel). A request that would raise, or when nothing is on, does nothing.
  function lower(args) {
    var c = call;
    if (!c || c.h.id !== String(args.id) || c.state !== 'active') throw new Error('There is no call to change.');
    if (args.what === 'mic') {
      if (c.mic) { c.mic = false; if (c.local) c.local.getAudioTracks().forEach(function (t) { t.enabled = false; }); render(); emit(c); }
      return true;
    }
    if (args.what === 'cam') { if (c.cam) return camera(c).then(function () { return true; }); return true; }
    throw new Error('Unknown control.');
  }
  function state() { return call ? view(call) : null; }

  p2p.attach('call', { message: message, closed: closed });
  window.keoCall = { start: start, end: end, lower: lower, state: state, onEvent: function (fn) { listener = fn; } };
})();
