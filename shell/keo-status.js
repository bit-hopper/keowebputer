// What the toolbar popup (popup.js) may learn from this page: who is signed in, when the session ends, and for each friend whether a
// connection is up and how the last one ended. The popup is a separate extension page that is closed whenever focus leaves it, so it
// asks again each time it opens and while it is open.
// PLAIN DATA ONLY. It carries the identity's DID and its label, the session's end time, and for each friend the DID, the name the
// friend gave itself, a state word, a time and one of this page's own sentences. Never a key, a code, a message, a file name, an
// address, or the connection log. Names are text another device chose: the reader must draw them as text.
// Who may ask: a message from this extension's own popup page, nobody else (the sandboxed world has no extension messaging at all,
// and the page checks the sender anyway). Reading changes nothing. What can be asked that does something is small and none of it
// raises what anyone may do: 'popup.reconnect' (for a FRIEND only: it tells the world, as an event, that the person wants to reconnect
// to that friend, and the world opens the Connect a device window for it; nothing is connected by asking), 'popup.cancel' (gives up the
// reconnects under way to one friend) and 'popup.open' (the world is told to open the Messages window for a CONNECTED friend or the
// Connect a device window, or to sign out, which only lowers privilege). It cannot add or remove a friend, sign in, or touch a live
// connection. The world does the opening, so a world that is not up simply does nothing.
// What it is NOT: a bridge op. The world cannot reach it, and it must not be given one.
(function () {
  'use strict';
  var MAX_FRIENDS = 100;
  var RANK = { connected: 0, unconfirmed: 1, connecting: 2, reconnecting: 3 };

  // For one friend: the best live connection to its DID, else how the last one ended, else nothing.
  function friendView(p, st) {
    var live = st.connections.filter(function (c) { return c.did === p.did; }).sort(function (a, b) { return RANK[a.state] - RANK[b.state]; })[0];
    var end = st.ended[p.did] || null;
    var state = 'idle', since = null, why = null;
    if (live) { state = live.state; since = live.since; }
    else if (end && end.why !== 'Closed here.') { state = end.lost ? 'lost' : 'ended'; }
    return { did: p.did, name: p.name, state: state, since: since, waiting: !!(live && live.waiting), seen: p.seen ? Date.parse(p.seen) || null : null,
      ended: state === 'lost' || state === 'ended' ? { at: end.at, why: end.why } : null };
  }

  function build() {
    return window.keoIdentity.current().then(function (s) {
      if (!s) return { v: 1, signedIn: false };
      var out = { v: 1, signedIn: true, me: { did: s.did, label: s.label }, exp: s.exp, friends: null };
      return window.keoContacts.list().then(function (people) {
        var st = window.keoP2p.status();
        out.friends = people.slice(0, MAX_FRIENDS).map(function (p) { return friendView(p, st); });
        return out;
      }, function () { return out; });            // friends stays null: the book could not be read
    });
  }

  // ---- what the popup may do ---------------------------------------------------------------------------------------------
  // The world is told through one listener, set by shell.js (events are not queued: a world that is not up misses it, and the person
  // then finds nothing opened). Resolves { ok } or { ok: false, error }.
  var reconnectListener = null;
  function reconnect(did) {
    if (typeof did !== 'string') return Promise.resolve({ ok: false, error: 'That is not a valid device identity.' });
    return window.keoIdentity.current().then(function (s) {
      if (!s) return { ok: false, error: 'Nobody is signed in.' };
      return window.keoContacts.ensure().then(function () {
        var f = window.keoContacts.get(did);
        if (!f) return { ok: false, error: 'That device is not in your friends.' };
        // Connected, or a connection to it is already under way: nothing to start.
        if (window.keoP2p.status().connections.some(function (c) { return c.did === did; })) return { ok: true, already: true };
        if (!reconnectListener) return { ok: false, error: 'keo is not ready.' };
        reconnectListener({ did: did, name: f.name });
        return { ok: true };
      });
    }).catch(function (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 200) }; });
  }
  // 'popup.open': what the world is asked to open or do. Only the three below, and only while someone is signed in; a chat only for a
  // friend that is connected now. Resolves { ok } or { ok: false, error }.
  var openListener = null;
  function open(what, did) {
    if (what !== 'chat' && what !== 'connect' && what !== 'signout') return Promise.resolve({ ok: false, error: 'That is not a valid request.' });
    return window.keoIdentity.current().then(function (s) {
      if (!s) return { ok: false, error: 'Nobody is signed in.' };
      if (!openListener) return { ok: false, error: 'keo is not ready.' };
      if (what !== 'chat') { openListener({ what: what }); return { ok: true }; }
      if (typeof did !== 'string') return { ok: false, error: 'That is not a valid device identity.' };
      return window.keoContacts.ensure().then(function () {
        var f = window.keoContacts.get(did);
        if (!f) return { ok: false, error: 'That device is not in your friends.' };
        if (!window.keoP2p.status().connections.some(function (c) { return c.did === did && c.state === 'connected'; })) return { ok: false, error: 'That friend is not connected.' };
        openListener({ what: 'chat', did: did, name: f.name });
        return { ok: true };
      });
    }).catch(function (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 200) }; });
  }
  function cancel(did) {
    if (typeof did !== 'string') return Promise.resolve({ ok: false });
    window.keoP2p.cancelFor(did);
    return Promise.resolve({ ok: true });
  }

  var POPUP = chrome.runtime.getURL('popup.html');
  chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
    if (!msg || typeof msg.keo !== 'string' || msg.keo.indexOf('popup.') !== 0) return false;
    if (sender.id !== chrome.runtime.id || !sender.url || sender.url.split(/[?#]/)[0] !== POPUP) return false;
    if (msg.keo === 'popup.status') build().then(reply, function () { reply(null); });
    else if (msg.keo === 'popup.reconnect') reconnect(msg.did).then(reply);
    else if (msg.keo === 'popup.cancel') cancel(msg.did).then(reply);
    else if (msg.keo === 'popup.open') open(msg.what, msg.did).then(reply);
    else return false;
    return true;                                  // the answer is sent later
  });
  window.keoStatus = { build: build, onReconnect: function (fn) { reconnectListener = fn; }, onOpen: function (fn) { openListener = fn; } };
})();
