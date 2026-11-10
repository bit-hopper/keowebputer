// keo cards, SHELL side: telling a friend where this device can be asked to connect, and keeping what a friend tells us. Runs in the
// extension's own page; the sandboxed world is assumed hostile and has NO way to reach this: nothing here is behind a bridge op, so the
// addresses a friend's device published never leave this page (keo-contacts.js keeps them out of the view the world can list).
// The card itself (what it says, how it is signed and checked, the rule for keeping it) is keo-hello.js; this file only moves it.
//   card.set { hello, sig }   a card signed by the sender's device key. Sent to a FRIEND, as soon as the connection becomes one and again
//                             whenever our helpers change. The receiver checks it as coming from the DID the connection proved, and
//                             keeps it only if that DID is in the friend book.
//
// What it does NOT do (so nobody assumes it):
//  - It never sends a card until helpers have been set (setHelpers) in this page's life. Nothing sets them yet: no helper exists. A card
//    that lists no helper is sent only after setHelpers([]) was called on purpose, which says "I can no longer be reached there".
//  - It keeps nothing about OUR helpers across a restart. The program that runs a helper sets them each time it starts.
//  - A card from someone who is not a friend is not taken over the connection (keo-p2p.js lets only friends' modules speak), and one that
//    comes as text (importText) is kept only for a DID already in the friend book. Adding a friend from a card is not built: it would
//    need its own question to the person, like the eight-word check.
//  - A bad card is dropped and noted (diag()), not a reason to close the connection: a clock that is a little off must not cost a call.
(function () {
  'use strict';
  var p2p = window.keoP2p, hello = window.keoHello, ident = window.keoIdentity, contacts = window.keoContacts;
  var MAX_CARDS_PER_CONNECTION = 30;  // a helper whose address changes now and then is fine; a friend that keeps sending is cut off
  var helpers = null;               // null: never said. Else the list we publish (possibly empty).
  var lastSeq = 0;                  // a card made within the same second as the last still counts as newer
  var live = {};                    // connection id -> handle, for the connections to friends that are ready
  var counts = {}, notes = {};      // per connection: cards received, and the last reason one was dropped

  function sendOwn(h) {
    if (helpers === null || !h.ready() || !h.friend) return Promise.resolve(false);
    return ownCard().then(function (msg) {
      if (!h.ready() || !h.friend) return false;
      h.send({ t: 'card.set', hello: msg.hello, sig: msg.sig });
      return true;
    }).catch(function (e) { notes[h.id] = 'could not send our card: ' + (e && e.message || e); return false; });
  }
  // Our card as it would be sent now. A new one each time (a new version number, a new signature), never cached: the delegation
  // certificate inside it is the session's, so a stale copy would carry a certificate that may have expired.
  function ownCard() {
    return ident.deviceProof().then(function (proof) {
      var seq = Math.max(Math.floor(Date.now() / 1000), lastSeq + 1);
      var h = hello.cardBuild(proof, { helpers: helpers || [], seq: seq });
      return ident.signWithDevice(hello.signedBytes(h), proof.did).then(function (sig) { lastSeq = seq; return { hello: h, sig: sig }; });
    });
  }

  // ---- the protocol ---------------------------------------------------------------------------------------------------
  function ready(h) { if (h.friend) { live[h.id] = h; sendOwn(h); } }
  function friend(h) { live[h.id] = h; sendOwn(h); }
  function closed(h) { delete live[h.id]; delete counts[h.id]; delete notes[h.id]; }
  function message(h, m) {
    if (m.t !== 'card.set') throw new Error('a bad message (' + m.t + ')');
    counts[h.id] = (counts[h.id] || 0) + 1;
    if (counts[h.id] > MAX_CARDS_PER_CONNECTION) throw new Error('too many cards');
    var did = h.peer.did;
    return hello.verifyCard({ hello: m.hello, sig: m.sig }, { did: did, audience: location.origin }).then(function (v) {
      if (!v.ok) { notes[h.id] = 'dropped a card: ' + v.error; return; }
      return contacts.setCard(did, v).then(function () { notes[h.id] = 'kept a card (version ' + v.seq + ')'; });
    }).catch(function (e) { notes[h.id] = 'could not keep a card: ' + (e && e.message || e); });
  }

  // ---- for code in this page ------------------------------------------------------------------------------------------
  // The helpers this device publishes: [{ kind: 'ws'|'http', host, port }], at most hello.MAX_HELPERS. Throws a sentence for one that
  // keo-hello.js would not sign (the promise is rejected, nothing is changed). Every friend we are connected to is sent the new card.
  function setHelpers(list) {
    if (!Array.isArray(list) || list.length > hello.MAX_HELPERS) return Promise.reject(new Error('A card holds at most ' + hello.MAX_HELPERS + ' helpers.'));
    for (var i = 0; i < list.length; i++) { var e = hello.helperError(list[i]); if (e) return Promise.reject(new Error('That helper is not valid: ' + e + '.')); }
    helpers = list.map(function (x) { return { kind: x.kind, host: x.host, port: x.port }; });
    return Promise.all(Object.keys(live).map(function (k) { return sendOwn(live[k]); })).then(function () { return true; });
  }
  // Our card as one line of text, to show as a link or paste somewhere (keo-hello.js cardToText: a few kilobytes, valid for as long as
  // this session's certificate, 12 hours at most).
  function exportText() { return ownCard().then(function (msg) { return hello.cardToText(msg); }); }
  // Reads a card from text and keeps it if the person who made it is already a friend. Resolves { did, deviceId, added, changed }:
  // `added` false means the card is genuine but from someone not in the friend book, so NOTHING was kept. Throws a sentence when the
  // text is not a valid card (unreadable, altered, from an expired session, for another app).
  function importText(text) {
    var msg;
    try { msg = hello.cardFromText(text); } catch (e) { return Promise.reject(e); }
    return hello.verifyCard(msg, { audience: location.origin }).then(function (v) {
      if (!v.ok) throw new Error(v.error);
      return contacts.ensure().then(function () {
        if (!contacts.isAdded(v.did)) return { did: v.did, deviceId: v.deviceId, added: false, changed: false };
        return contacts.setCard(v.did, v).then(function (r) { return { did: v.did, deviceId: v.deviceId, added: true, changed: !!(r && r.changed) }; });
      });
    });
  }
  // Who we are and where we can be asked, small enough for a QR (keo-hello.js introToText: unsigned, about 250 characters). The helpers are
  // the ones set with setHelpers (none: the introduction names only the identity). Needs a signed-in identity.
  function exportIntro() {
    return ident.current().then(function (s) {
      if (!s) throw new Error('Sign in first.');
      return hello.introToText({ did: s.did, name: s.label, helpers: helpers || [] });
    });
  }
  // Reads an introduction from text. Resolves { did, name, helpers, added }: `added` says whether that identity is already in the friend
  // book. NOTHING is kept and nobody is added: the DID is only what the other person claims, so a screen must show it for the person to
  // check (the eight words) before adding anyone, and must not treat `name` as who it is. Throws a sentence for text that is not valid.
  function importIntro(text) {
    var intro;
    try { intro = hello.introFromText(text); } catch (e) { return Promise.reject(e); }
    return contacts.ensure().then(function () {
      return { did: intro.did, name: intro.name, helpers: intro.helpers, added: contacts.isAdded(intro.did) };
    });
  }
  // For tests and for a person reading the log: the last thing that happened to a card on each live connection.
  function diag() { return { notes: JSON.parse(JSON.stringify(notes)), live: Object.keys(live), helpers: helpers && helpers.slice() }; }
  // The session ended: nothing of one identity is left for the next.
  function reset() { helpers = null; lastSeq = 0; live = {}; counts = {}; notes = {}; }

  p2p.attach('card', { message: message, ready: ready, friend: friend, closed: closed });
  window.keoCards = { setHelpers: setHelpers, exportText: exportText, importText: importText, exportIntro: exportIntro, importIntro: importIntro, diag: diag, reset: reset };
})();
