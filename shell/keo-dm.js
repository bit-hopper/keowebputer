// Text messages between two connected devices, SHELL side: the part of Messages that needs no host. A message travels over the
// channel keo-p2p.js already proved (so it is encrypted and authenticated by the connection itself and comes from the DID that
// proved itself), and only while the two devices are connected: with no host there is nowhere to leave a message for later.
//
// The world sends with dm.send and receives by PULLING: an arriving message is kept here until the world has taken it (dm.take)
// and said it has saved it (dm.done), and the event only says "something is waiting". The shell's events are not queued, so a
// world that is restarting would otherwise lose a message that was already acknowledged on the wire. What is kept here lives in
// this page's memory only: a message the world has not taken when the page is closed is gone.
// Limits (a hostile peer is assumed): text up to MAX_TEXT characters, at most MAX_PENDING waiting messages (more closes the
// connection), anything malformed closes it. The time of a message is when it ARRIVED here, never a time the peer claims.
// Not done: delivery receipts, typing indicators, anything but plain text, history in the shell (the world keeps it, see Messages).
(function () {
  'use strict';
  var p2p = window.keoP2p, kd = window.keoDid;
  var MAX_TEXT = 8000, MAX_PENDING = 500, MID = /^[A-Za-z0-9_-]{8,24}$/;
  var pending = [], listener = null;

  function emit(ev) { if (listener) { try { listener(ev); } catch (e) {} } }

  function message(h, m) {
    if (m.t !== 'dm.text' || typeof m.mid !== 'string' || !MID.test(m.mid) || typeof m.text !== 'string' || !m.text.length || m.text.length > MAX_TEXT) {
      throw new Error('a bad message (' + m.t + ')');
    }
    if (pending.length >= MAX_PENDING) throw new Error('too many messages waiting');
    if (pending.some(function (x) { return x.mid === m.mid && x.id === h.id; })) return;          // a repeat
    pending.push({ id: h.id, mid: m.mid, text: m.text, at: Date.now(), peer: { did: h.peer.did, name: h.peer.name || null } });
    emit({ type: 'dm', id: h.id, waiting: pending.length });
  }
  function closed(h) { emit({ type: 'dm-closed', id: h.id }); }

  // ---- what the world may ask ---------------------------------------------------------------------------------------
  function send(args) {
    var h = p2p.handle(args.id), text = args.text;
    if (typeof text !== 'string' || !text.length) throw new Error('There is nothing to send.');
    if (text.length > MAX_TEXT) throw new Error('That message is too long (the limit is ' + MAX_TEXT + ' characters).');
    var mid = kd.b64u(crypto.getRandomValues(new Uint8Array(9)));
    h.send({ t: 'dm.text', mid: mid, text: text });
    return { mid: mid, at: Date.now(), peer: { did: h.peer.did, name: h.peer.name || null } };
  }
  function take() { return pending.slice(); }
  function done(args) {
    var mids = Array.isArray(args.mids) ? args.mids.map(String) : [];
    pending = pending.filter(function (x) { return mids.indexOf(x.mid) < 0; });
    return pending.length;
  }

  p2p.attach('dm', { message: message, closed: closed });
  window.keoDm = { send: send, take: take, done: done, onEvent: function (fn) { listener = fn; } };
})();
