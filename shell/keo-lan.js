// Dialing a friend by key on the local network, SHELL side. Runs in the page of the desktop app; where the app offers no way onto the network
// (the extension, a browser) it finds nothing to talk to and stays out of the way.
//
// WHAT IT DOES. While a person is signed in, the app (keo-desktop, lib/lan.js) listens for announcements on the local network and, if the
// person is visible, announces this device. An announcement carries a short tag made from the identity's DID and the time (below), nothing
// else. This page keeps the tag of every friend in the book; a tag it recognises says "that friend is on this network, at this address".
// Dialing a friend is then the ordinary connection (keo-p2p.js offer, answer, finish) with the two codes carried over the network by the
// app instead of by hand, and `expect` set to the friend's DID.
//
// WHO IS TRUSTED WITH WHAT. Nothing on the network is trusted to say who it is.
//  - An announcement is a claim about an address. Anyone can send one. The worst it does is make a dial go to the wrong address, where the
//    answer is refused (the request is signed for one receiver) or the connection proves a different identity and is closed (`expect`).
//  - The request that asks a friend to answer (keo-hello.js dialBuild) is signed by the asker's device key, names the receiver and the hash
//    of the code, and is fresh. The receiver answers only an identity it has ADDED, only once per request, and says nothing else to anyone
//    (every refusal is the same one-word reply). Because the codes name nobody, the connection's own proof still decides who is there.
//  - The request is not encrypted: anyone on the network can read the asker's DID, the receiver's DID and the connection code (which
//    holds this device's local addresses). It is for a network the person is on by choice (home, an office); the setting that makes this
//    device visible can be turned off, and the person is told so in the UI that offers it.
// THE TAG. tag = first 16 bytes of SHA-256("keo-lan-1|" + DID + "|" + the five-minute period). A friend (who knows the DID) can compute it; a
// stranger who does not know the DID cannot tell whose it is or follow it from one period to the next. Someone who does know a DID can see
// whether that identity is on the network. Periods either side of this one are accepted, so clocks a few minutes apart still match.
// The world can: ask whether it is available, read the setting and who was found, change the setting, and ask to dial a friend. It cannot
// see an address, a code or a tag. Never add an op that returns one of those.
(function () {
  'use strict';
  var kd = window.keoDid, hello = window.keoHello, ident = window.keoIdentity, p2p = window.keoP2p, contacts = window.keoContacts;
  var enc = new TextEncoder(), dec = new TextDecoder();
  var EPOCH_MS = 5 * 60 * 1000, TICK_MS = 4000, MAX_REQUEST = 48 * 1024, MAX_B64 = Math.ceil(MAX_REQUEST * 4 / 3) + 16;
  var NONCE_KEEP_MS = hello.DIAL_AGE_MS + 3 * 60 * 1000, MAX_NONCES = 500, ANSWER_COOLDOWN_MS = 1500, MAX_ANSWERING = 3, OPEN_WAIT_MS = 45000;
  // Whether a signed-in person is visible on the network when they have not chosen. The announcement says nothing a stranger can read (above),
  // and a friend cannot find a device that does not announce itself, so the default is on; the setting is `lanVisible` (keo-worlds.js).
  var DEFAULT_VISIBLE = true;

  var avail = null;                 // null: not asked yet, true/false once the app has answered
  var started = false, lastPayload = null, visibleNow = DEFAULT_VISIBLE, busy = false, timer = null, listener = null;
  var found = {};                   // friend DID -> { ip, port, at }
  var tagOwners = {}, tagKey = '';  // tag -> friend DID, for the periods around now; rebuilt when the period or the book changes
  var nonces = {}, nonceCount = 0;  // nonce -> time it was seen
  var lastFrom = {}, answering = {}, dialing = {};
  var lastNote = null;              // the last thing that went wrong with the network, as a sentence, for the person

  function emit(ev) { if (listener) { try { listener(ev); } catch (e) {} } }
  // The app's secret (see keo-desktop main.js): pushed into this page when its document is ready, read once, taken off `window` and kept
  // in this closure. Without it the app answers 403. The world page cannot read it, and no bridge op returns it.
  var tokenWanted = null;
  function getToken() {
    if (tokenWanted) return tokenWanted;
    tokenWanted = new Promise(function (resolve) {
      var t0 = Date.now();
      (function look() {
        if (typeof window.__keoHostToken === 'string') { var t = window.__keoHostToken; try { delete window.__keoHostToken; } catch (e) { window.__keoHostToken = undefined; } return resolve(t); }
        if (Date.now() - t0 > 15000) return resolve(null);
        setTimeout(look, 100);
      })();
    });
    return tokenWanted;
  }
  function hostCall(op, args) {
    return getToken().then(function (token) {
      if (!token) throw new Error('The app gave this page no way onto the network.');
      return fetch('/.keo-host/lan', { method: 'POST', headers: { 'x-keo-host': token, 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ op: op }, args || {})) });
    }).then(function (r) { if (!r.ok) throw new Error('The app answered ' + r.status + '.'); return r.json(); });
  }
  function tagFor(did, period) { return kd.sha256(enc.encode('keo-lan-1|' + did + '|' + period)).then(function (h) { return kd.b64u(h.slice(0, 16)); }); }
  function periodOf(t) { return Math.floor(t / EPOCH_MS); }

  // ---- the setting ----------------------------------------------------------------------------------------------------------
  function getVisible() {
    return window.keoWorlds.prefsGet().then(function (p) { return typeof p.lanVisible === 'boolean' ? p.lanVisible : DEFAULT_VISIBLE; });
  }
  async function setVisible(args) {
    if (typeof args.on !== 'boolean') throw new Error('on must be true or false.');
    await window.keoWorlds.prefsSet({ key: 'lanVisible', value: args.on });
    visibleNow = args.on;
    await tick();
    return { visible: args.on };
  }

  // ---- looking around: one round every few seconds while signed in -----------------------------------------------------------
  async function ownTags(friends) {
    var p = periodOf(Date.now()), key = p + '|' + friends.join(',');
    if (key === tagKey) return;
    var owners = {};
    for (var i = 0; i < friends.length; i++) for (var d = -1; d <= 1; d++) owners[await tagFor(friends[i], p + d)] = friends[i];
    tagOwners = owners; tagKey = key;
  }
  async function tick() {
    if (!avail || busy) return;
    busy = true;
    try {
      var s = await ident.current();
      if (!s) { if (started) { started = false; lastPayload = null; await hostCall('stop'); } if (Object.keys(found).length) { found = {}; emit({ type: 'found', found: [] }); } return; }
      visibleNow = await getVisible();
      var payload = visibleNow ? await tagFor(s.did, periodOf(Date.now())) : null;
      if (!started || payload !== lastPayload) {
        var r0 = await hostCall('start', { payload: payload });
        if (r0.error) throw new Error(r0.error);
        started = true; lastPayload = payload;
      }
      var book = await contacts.list();
      await ownTags(book.map(function (b) { return b.did; }).sort());
      var r = await hostCall('peers');
      var next = {}, now = Date.now();
      (r.peers || []).forEach(function (p) { var did = tagOwners[p.payload]; if (did && (!next[did] || next[did].at < now - p.age)) next[did] = { ip: p.ip, port: p.port, at: now - p.age }; });
      var before = Object.keys(found).sort().join(','), after = Object.keys(next).sort().join(',');
      found = next;
      lastNote = null;
      if (before !== after) emit({ type: 'found', found: Object.keys(next) });
    } catch (e) {
      lastNote = 'The network could not be used: ' + (e && e.message || e);
    } finally { busy = false; }
  }

  // ---- dialing a friend -----------------------------------------------------------------------------------------------------
  async function dial(args) {
    var did = args && args.did;
    var s = await ident.current();
    if (!s) throw new Error('Sign in to connect.');
    if (!avail) throw new Error('Finding friends on the network works only in the desktop app.');
    await contacts.ensure();
    if (typeof did !== 'string' || !contacts.isAdded(did)) throw new Error('That is not a friend you have added.');
    if (p2p.connectionsTo(did).length) throw new Error('You are already connected to this friend.');
    if (dialing[did]) throw new Error('Already trying to reach this friend.');
    dialing[did] = true;
    var off = null;
    try {
      await tick();
      var at = found[did];
      if (!at) throw new Error(lastNote || 'This friend was not found on this network. They need to be signed in on a computer on the same network, with the app open and visible.');
      off = await p2p.offer({ expect: did });
      var proof = await ident.deviceProof();
      var nonce = kd.b64u(crypto.getRandomValues(new Uint8Array(16)));
      var h = hello.dialBuild(proof, { to: did, nonce: nonce, c: kd.b64u(await kd.sha256(enc.encode(off.code))) });
      var sig = await ident.signWithDevice(hello.signedBytes(h), proof.did);
      var bytes = enc.encode(JSON.stringify({ t: 'dial', hello: h, sig: sig, code: off.code }));
      if (bytes.length > MAX_REQUEST) throw new Error('The request is too large to send.');
      var r = await hostCall('request', { ip: at.ip, port: at.port, body: kd.b64u(bytes) });
      if (r.error) throw new Error(r.error);
      var reply;
      try { reply = JSON.parse(dec.decode(kd.unb64u(r.reply))); } catch (e) { reply = null; }
      if (!reply || reply.t !== 'ok' || typeof reply.code !== 'string') throw new Error('Your friend did not accept the connection. They may not have added you, or are already connected.');
      await p2p.finish({ id: off.id, code: reply.code });
      return { id: off.id };
    } catch (e) {
      if (off) { try { p2p.close({ id: off.id }); } catch (x) {} }
      throw e;
    } finally { delete dialing[did]; }
  }

  // ---- being dialed: called by the app with a request that came in over the network ----------------------------------------------
  // Resolves the reply (base64url) or null. Every refusal is the same reply, so a stranger learns nothing from which check failed.
  var NO = kd.b64u(enc.encode(JSON.stringify({ t: 'no' })));
  async function inbound(b64, ip) {
    var slot = null;                  // the DID whose answer is being made: released when the attempt ends
    try {
      var s = await ident.current();
      if (!s || !visibleNow || typeof b64 !== 'string' || b64.length > MAX_B64) return null;
      var t = Date.now(), from = String(ip);
      if (t - (lastFrom[from] || 0) < ANSWER_COOLDOWN_MS) return null;
      lastFrom[from] = t;
      Object.keys(lastFrom).forEach(function (k) { if (t - lastFrom[k] > 60000) delete lastFrom[k]; });
      pruneAnswering();
      if (Object.keys(answering).length >= MAX_ANSWERING) return null;
      var msg = JSON.parse(dec.decode(kd.unb64u(b64)));
      if (!msg || msg.t !== 'dial' || typeof msg.code !== 'string' || msg.code.length > 1024) return NO;
      var c = kd.b64u(await kd.sha256(enc.encode(msg.code)));
      var v = await hello.verifyDial({ hello: msg.hello, sig: msg.sig }, { to: s.did, c: c, audience: location.origin });
      if (!v.ok) return NO;
      // The nonce is remembered only for a request that verified, so junk cannot fill the list.
      Object.keys(nonces).forEach(function (k) { if (t - nonces[k] > NONCE_KEEP_MS) { delete nonces[k]; nonceCount--; } });
      if (nonces[v.nonce] || nonceCount >= MAX_NONCES) return NO;
      nonces[v.nonce] = t; nonceCount++;
      await contacts.ensure();
      pruneAnswering();
      if (!contacts.isAdded(v.did) || p2p.connectionsTo(v.did).length || answering[v.did]) return NO;
      answering[v.did] = { id: null }; slot = v.did;
      var a = await p2p.answer({ code: msg.code, expect: v.did });
      answering[v.did].id = a.id;
      // The asker finishes at once. If it never does, this connection must not wait for the 15 minutes an invitation lives.
      setTimeout(function () {
        var c2 = p2p.list().filter(function (x) { return x.id === a.id; })[0];
        if (c2 && c2.state !== 'ready' && c2.state !== 'open') { try { p2p.close({ id: a.id }); } catch (e) {} }
        pruneAnswering();
      }, OPEN_WAIT_MS);
      return kd.b64u(enc.encode(JSON.stringify({ t: 'ok', code: a.code })));
    } catch (e) {
      if (slot) delete answering[slot];
      return null;
    }
  }

  // An answer being made holds a place for that friend until its connection is up, gone or closed: a friend who dials again after a drop
  // must not be turned away because the last attempt is still on the list. A place whose connection never came up is freed by the timer above.
  function pruneAnswering() {
    var live = {};
    p2p.list().forEach(function (c) { live[c.id] = c; });
    Object.keys(answering).forEach(function (did) {
      var slotInfo = answering[did], c = slotInfo.id && live[slotInfo.id];
      if (slotInfo.id && (!c || c.state === 'ready' || c.state === 'open' || c.state === 'closed')) delete answering[did];
    });
  }

  async function status() {
    var s = await ident.current();
    var names = {};
    if (s) { try { (await contacts.list()).forEach(function (b) { names[b.did] = b.name || null; }); } catch (e) {} }
    return { available: !!avail, signedIn: !!s, visible: visibleNow, note: lastNote,
      found: Object.keys(found).map(function (d) { return { did: d, name: names[d] || null }; }) };
  }
  function reset() { found = {}; nonces = {}; nonceCount = 0; lastFrom = {}; answering = {}; dialing = {}; tagOwners = {}; tagKey = ''; lastPayload = null;
    if (started) { started = false; if (avail) hostCall('stop').catch(function () {}); } }

  // Asked once: does this page have the app's network pipe? Only an address of the app itself can: the extension and a plain browser page
  // do not, and then nothing else here runs.
  if (location.protocol === 'https:') {
    hostCall('hello').then(function (r) {
      if (!r || r.ok !== true) return;
      avail = true;
      tick();
      timer = setInterval(tick, TICK_MS);
    }, function () { avail = false; });
  } else avail = false;

  // hostCall is for code in THIS page and for tests: the page can already do whatever it allows. Never put it behind a bridge op.
  window.keoLan = { hostCall: hostCall, inbound: inbound, dial: dial, status: status, setVisible: setVisible, reset: reset, refresh: tick, onEvent: function (fn) { listener = fn; } };
})();
