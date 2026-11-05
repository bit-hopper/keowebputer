// The toolbar popup: what appears when the icon is clicked, before keo opens. It is its own extension page, separate from the
// shell tab, and it is closed (and loses its page) whenever focus leaves it, so it holds nothing: every time it opens it asks
// again, and while it is open it asks again every few seconds.
// It tells three situations apart without the shell tab:
//   - no identity on this device (first run);
//   - an identity exists but no keo tab is open: nobody is signed in, because a session lives in one shell tab's memory and a
//     closed tab ends it (keo-identity.js), so it shows which identities would sign in;
//   - a keo tab is open: the button brings it forward instead of opening a second one (a second tab would be a second session
//     that has to sign in on its own).
// and, when a keo tab is open, it asks that tab (keo-status.js) who is signed in, when the session ends and, for each friend, whether
// a connection is up or how the last one ended. If more than one keo tab is open it shows the first one that is signed in.
// What it must NOT do: read or show anything but each identity's label and DID from the stored records (they also hold the wrapped
// secrets), write anything, start a sign-in or change a connection itself, or draw anything it was told as markup (names are text
// another device chose). Signing in, connecting and everything else belong to the shell tab.
(function () {
  'use strict';
  var START = chrome.runtime.getURL('start.html');
  var MAX_SHOWN = 3, POLL_MS = 2000, ASK_MS = 1500, ENDING_MS = 15 * 60 * 1000;
  var root = document.getElementById('popup');

  // ---- what exists ---------------------------------------------------------------------------------------------------
  // The identity store is the shell's (keo-identity.js: database keo-identities, store identities, keyed by DID). This reads it
  // and nothing else; if the database was never made there is no identity, and it must not be created from here.
  function identities() {
    return indexedDB.databases().then(function (dbs) {
      if (!dbs.some(function (d) { return d.name === 'keo-identities'; })) return [];
      return new Promise(function (res, rej) {
        var q = indexedDB.open('keo-identities', 1);
        q.onerror = function () { rej(q.error); };
        q.onsuccess = function () {
          var db = q.result, out = [];
          if (!db.objectStoreNames.contains('identities')) { db.close(); return res([]); }
          var c = db.transaction('identities', 'readonly').objectStore('identities').openCursor();
          c.onerror = function () { db.close(); rej(c.error); };
          c.onsuccess = function () {
            var cur = c.result;
            if (cur) { out.push({ did: String(cur.value.did), label: String(cur.value.label), createdAt: String(cur.value.createdAt) }); return cur.continue(); }
            db.close();
            res(out.sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; }));
          };
        };
      });
    });
  }

  // The shell tabs that are open: this extension's own pages are listed without any permission to read tab addresses.
  function keoTabs() {
    return chrome.runtime.getContexts({ contextTypes: ['TAB'] }).then(function (cs) {
      return cs.filter(function (c) { return c.documentUrl && c.documentUrl.split(/[?#]/)[0] === START && c.tabId >= 0; });
    });
  }

  // ---- asking the shell tab ----------------------------------------------------------------------------------------------
  var STATES = { connected: 1, unconfirmed: 1, connecting: 1, reconnecting: 1, lost: 1, ended: 1, idle: 1 };
  var isStr = function (v, max) { return typeof v === 'string' && v.length <= max; };
  // The answer is plain data from this extension's own page, but it is checked and copied anyway: whatever is not the expected
  // shape is dropped, so a mistake on the other side cannot become markup or a script error here.
  function clean(a) {
    if (!a || a.v !== 1 || typeof a.signedIn !== 'boolean') return null;
    if (!a.signedIn) return { signedIn: false };
    if (!a.me || !isStr(a.me.did, 200) || !isStr(a.me.label, 200) || !isStr(a.exp, 40) || isNaN(Date.parse(a.exp))) return null;
    var out = { signedIn: true, me: { did: a.me.did, label: a.me.label }, exp: Date.parse(a.exp), friends: null };
    if (Array.isArray(a.friends)) {
      out.friends = a.friends.filter(function (f) { return f && isStr(f.did, 200) && isStr(f.name, 200) && STATES[f.state]; }).slice(0, 100).map(function (f) {
        return { did: f.did, name: f.name, state: f.state, since: typeof f.since === 'number' ? f.since : null, waiting: f.waiting === true,
          seen: typeof f.seen === 'number' ? f.seen : null,
          ended: f.ended && typeof f.ended.at === 'number' && isStr(f.ended.why, 200) ? { at: f.ended.at, why: f.ended.why } : null };
      });
    }
    return out;
  }
  function ask(tab) {
    var asked = chrome.tabs.sendMessage(tab.tabId, { keo: 'popup.status' });
    var late = new Promise(function (res) { setTimeout(function () { res(null); }, ASK_MS); });
    return Promise.race([asked, late]).then(clean, function () { return null; });
  }
  // The first tab that is signed in, else the first that answered at all, else null (no tab answered: an older page, or one still
  // loading). The answer carries the id of the tab it came from, to send that tab what the person asks for.
  function statusFrom(tabs) {
    return Promise.all(tabs.map(function (t) { return ask(t).then(function (s) { if (s) s.tabId = t.tabId; return s; }); })).then(function (all) {
      return all.filter(function (s) { return s && s.signedIn; })[0] || all.filter(Boolean)[0] || null;
    });
  }
  // Asks the keo tab for something the person clicked. Resolves { ok } or { ok: false, error }.
  function tell(tabId, msg) {
    return chrome.tabs.sendMessage(tabId, msg).then(function (r) { return r || { ok: false, error: 'keo did not answer.' }; }, function () { return { ok: false, error: 'keo did not answer.' }; });
  }

  // ---- doing ---------------------------------------------------------------------------------------------------------
  function openKeo(tabs) {
    var go = tabs.length
      ? chrome.tabs.update(tabs[0].tabId, { active: true }).then(function () { return chrome.windows.update(tabs[0].windowId, { focused: true }); })
      : chrome.tabs.create({ url: START });
    return go.then(function () { window.close(); });
  }

  // ---- drawing (textContent only: a label is the person's own text, a name is another device's) -----------------------------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function add(parent) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]); return parent; }
  function shortDid(did) {
    var m = /^did:keo:[^:]+:([A-Za-z0-9_-]{43})$/.exec(did);
    return m ? 'keo:' + m[1].slice(0, 4) + '…' + m[1].slice(-4) : did.slice(0, 24);
  }
  function span(cls, text) { return el('span', cls, text); }
  function dur(ms) {
    var m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (m < 1) return 'under a minute';
    if (h < 1) return m + ' min';
    if (d < 1) return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
    return d + ' d';
  }
  // The mascot on its light tile (its dark hair edge disappears on a dark panel).
  function mask() { var m = el('span', 'mask'), i = el('img'); i.src = 'core/media/face-masks/keo.png'; i.alt = ''; return add(m, i); }
  function head(pillText, pillCls) {
    var who = add(el('div'), el('div', 'name', 'keo'), el('div', 'sub', 'prototype'));
    return add(el('div', 'head'), mask(), who, el('span', 'sp'), el('span', 'pill' + (pillCls ? ' ' + pillCls : ''), pillText));
  }
  function button(text, onClick) {
    var b = el('button', 'btn', text); b.type = 'button';
    b.addEventListener('click', function () { b.disabled = true; onClick().catch(function (e) { b.disabled = false; console.error('keo popup:', e); }); });
    return b;
  }
  function person(id) {
    var img = el('img'); img.src = window.keoIdenticon.dataUrl(id.did, 40); img.alt = '';
    return add(el('div', 'me'), img, add(el('div', 'who'), el('b', null, id.label), el('span', 'did', shortDid(id.did))));
  }

  // One friend's row: a dot and a word for the state, then what is known about it.
  var ORDER = { connected: 0, unconfirmed: 1, connecting: 2, reconnecting: 3, lost: 4, ended: 5, idle: 6 };
  // "last seen": the time of day if it was today, "yesterday" with it, else the date.
  function seenText(ms, now) {
    var d = new Date(ms), t = new Date(now), pad = function (n) { return (n < 10 ? '0' : '') + n; }, hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var day = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    if (day(d) === day(t)) return 'last seen today ' + hm;
    if (day(d) === day(t) - 86400000) return 'last seen yesterday ' + hm;
    return 'last seen ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + hm;
  }
  function smallButton(text, onClick, quiet) {
    var b = el('button', 'btn sm' + (quiet ? ' quiet' : ''), text); b.type = 'button';
    b.addEventListener('click', function () { b.disabled = true; onClick().catch(function (e) { b.disabled = false; console.error('keo popup:', e); }); });
    return b;
  }
  // act: { reconnect(did), cancel(did), show() } for the buttons.
  function friendRow(f, now, act) {
    var img = el('img'); img.src = window.keoIdenticon.dataUrl(f.did, 32); img.alt = '';
    var tone = { connected: 'good', unconfirmed: 'warn', connecting: 'warn', reconnecting: 'warn', lost: 'bad' }[f.state] || '';
    var l2 = el('div', 'l2');
    var who = f.name || shortDid(f.did);
    var word = { connected: 'Connected', unconfirmed: 'Connected', connecting: 'Connecting…', reconnecting: f.waiting ? 'Waiting for ' + who + '\'s reply' : 'Connecting…', lost: 'Connection lost', ended: 'Connection ended', idle: 'Not connected' }[f.state];
    add(l2, el('b', tone, word));
    if (f.state === 'connected' && f.since) l2.appendChild(document.createTextNode(' · ' + dur(now - f.since)));
    if (f.state === 'unconfirmed') l2.appendChild(document.createTextNode(' · waiting for them to add you'));
    if (f.ended) {
      l2.appendChild(document.createTextNode(' · ' + dur(now - f.ended.at) + ' ago'));
      if (f.ended.why) l2.appendChild(span('why', f.ended.why));
    }
    if (f.seen && (f.state === 'idle' || f.state === 'lost' || f.state === 'ended')) l2.appendChild(span('why', seenText(f.seen, now)));
    var l1 = add(el('div', 'l1'), el('i', 'dot ' + tone), span(null, who));
    var row = add(el('li', 'dev'), img, add(el('div'), l1, l2));
    if (f.state === 'reconnecting') {
      // The code lives in keo, in the Connect a device window: the popup closes when focus leaves it and holds nothing.
      row.className = 'dev wide';
      var extra = add(el('div', 'extra'), el('div', 'note', f.waiting ? 'Your code is ready in keo, in the Connect a device window. Send it to ' + who + ', then paste the code ' + who + ' sends back.' : 'Connecting…'),
        add(el('div', 'btns'), smallButton('Show in keo', act.show), smallButton('Cancel', function () { return act.cancel(f.did); }, true)));
      row.appendChild(extra);
    } else if (f.state === 'idle' || f.state === 'lost' || f.state === 'ended') {
      row.appendChild(smallButton(f.state === 'idle' ? 'Connect' : 'Reconnect', function () { return act.reconnect(f.did); }, f.state === 'idle'));
    }
    return row;
  }
  function friendsSection(friends, now, act) {
    if (friends === null) return el('div', 'empty', 'Your friends could not be read.');
    if (!friends.length) return el('div', 'empty', 'No friends yet. Add one from Connect a device in keo.');
    var sorted = friends.slice().sort(function (a, b) { return ORDER[a.state] - ORDER[b.state] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    var up = friends.filter(function (f) { return f.state === 'connected'; }).length;
    var list = el('ul', 'devs');
    sorted.forEach(function (f) { list.appendChild(friendRow(f, now, act)); });
    return add(el('div'), add(el('div', 'sec-h'), el('h3', null, 'Friends\' devices'), span(null, up + ' of ' + friends.length + ' connected')), list);
  }

  // The popup's whole content for what is known now, as a list of nodes.
  function view(ids, tabs, st, now) {
    var go = function (text) { return button(text, function () { return openKeo(tabs); }); };
    if (tabs.length && st && st.signedIn) {
      var left = st.exp - now, ending = left < ENDING_MS;
      var body = add(el('div', 'body'), person(st.me));
      if (ending) body.appendChild(el('div', 'banner', left > 0 ? 'Your session ends in ' + dur(left) + '. Sign in again to keep sharing and calling.' : 'Your session has ended.'));
      var act = {
        show: function () { return openKeo(tabs); },
        // Ask keo to open its Connect a device window for this friend, then bring the tab forward so the person sees it.
        reconnect: function (did) { return tell(st.tabId, { keo: 'popup.reconnect', did: did }).then(function (r) { if (!r.ok) throw new Error(r.error); return openKeo(tabs); }); },
        cancel: function (did) { return tell(st.tabId, { keo: 'popup.cancel', did: did }).then(function () { return refresh(); }); }
      };
      add(body, go('Switch to keo'), friendsSection(st.friends, now, act));
      return [head(ending ? 'Ends soon' : 'Signed in', ending ? 'warn' : 'good'), body, el('div', 'foot', left > 0 ? 'Session ends in ' + dur(left) : 'Session ended')];
    }
    if (tabs.length && st) {
      return [head('Open', 'good'), add(el('div', 'body'), el('p', 'note', 'keo is open in a tab. Nobody is signed in yet.'), go('Switch to keo'))];
    }
    if (tabs.length) {
      return [head('Open', 'good'), add(el('div', 'body'), el('p', 'note', 'keo is open in a tab.'), go('Switch to keo'))];
    }
    if (!ids.length) {
      var hero = add(el('div', 'hero'), mask(), el('h2', null, 'Make your identity'), el('p', null, 'It is made on this device with a passkey. Nothing is sent anywhere.'));
      return [head('No identity'), add(el('div', 'body'), hero, go('Make identity')), el('div', 'foot', 'Nothing is stored yet.')];
    }
    var b2 = add(el('div', 'body'));
    ids.slice(0, MAX_SHOWN).forEach(function (id) { b2.appendChild(person(id)); });
    if (ids.length > MAX_SHOWN) b2.appendChild(el('p', 'more', '+ ' + (ids.length - MAX_SHOWN) + ' more on this device'));
    add(b2, el('div', 'banner', 'Nobody is signed in. Signing in needs your passkey.'), go('Open keo and sign in'));
    return [head('Signed out'), b2, el('div', 'foot', 'Saved worlds stay on this device.')];
  }

  // Draws only when something shows differently, and keeps a focused button focused: the popup is redrawn while it is open.
  function show(nodes) {
    var next = document.createElement('div');
    nodes.forEach(function (n) { next.appendChild(n); });
    if (next.innerHTML === root.innerHTML) return;
    var hadFocus = root.contains(document.activeElement) && document.activeElement.classList.contains('btn');
    root.textContent = '';
    while (next.firstChild) root.appendChild(next.firstChild);
    if (hadFocus) { var b = root.querySelector('.btn'); if (b) b.focus(); }
  }

  function refresh() {
    return Promise.all([identities(), keoTabs()]).then(function (r) {
      return (r[1].length ? statusFrom(r[1]) : Promise.resolve(null)).then(function (st) { show(view(r[0], r[1], st, Date.now())); });
    }).catch(function (e) {
      // If the popup cannot tell what state things are in, the one safe thing it can still do is open keo.
      console.error('keo popup:', e);
      show([head('Unavailable'), add(el('div', 'body'), el('p', 'note', 'The state of keo could not be read.'), button('Open keo', function () { return openKeo([]); }))]);
    });
  }
  refresh().then(function () { setInterval(refresh, POLL_MS); });
})();
