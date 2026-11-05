// What the toolbar popup (popup.js) may learn from this page: who is signed in, when the session ends, and for each friend whether a
// connection is up and how the last one ended. The popup is a separate extension page that is closed whenever focus leaves it, so it
// asks again each time it opens and while it is open.
// PLAIN DATA ONLY. It carries the identity's DID and its label, the session's end time, and for each friend the DID, the name the
// friend gave itself, a state word, a time and one of this page's own sentences. Never a key, a code, a message, a file name, an
// address, or the connection log. Names are text another device chose: the reader must draw them as text.
// Who may ask: a message from this extension's own popup page, nobody else (the sandboxed world has no extension messaging at all,
// and the page checks the sender anyway). It only reads: nothing here changes a connection, a friend or the session.
// What it is NOT: a bridge op. The world cannot reach it, and it must not be given one.
(function () {
  'use strict';
  var MAX_FRIENDS = 100;
  var RANK = { connected: 0, unconfirmed: 1, connecting: 2 };

  // For one friend: the best live connection to its DID, else how the last one ended, else nothing.
  function friendView(p, st) {
    var live = st.connections.filter(function (c) { return c.did === p.did; }).sort(function (a, b) { return RANK[a.state] - RANK[b.state]; })[0];
    var end = st.ended[p.did] || null;
    var state = 'idle', since = null, why = null;
    if (live) { state = live.state; since = live.since; }
    else if (end && end.why !== 'Closed here.') { state = end.lost ? 'lost' : 'ended'; }
    return { did: p.did, name: p.name, state: state, since: since, ended: state === 'lost' || state === 'ended' ? { at: end.at, why: end.why } : null };
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

  var POPUP = chrome.runtime.getURL('popup.html');
  chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
    if (!msg || msg.keo !== 'popup.status') return false;
    if (sender.id !== chrome.runtime.id || !sender.url || sender.url.split(/[?#]/)[0] !== POPUP) return false;
    build().then(reply, function () { reply(null); });
    return true;                                  // the answer is sent later
  });
  window.keoStatus = { build: build };
})();
