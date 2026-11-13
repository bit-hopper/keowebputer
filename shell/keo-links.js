// Links that leave keo, SHELL side. Runs in the extension's own page; the sandboxed world is assumed hostile. A page the world shows (a book, a
// PDF, a message) can hold a link, and following it takes the person out of keo. The world draws the warning (lively.identity.LinkWarning) and
// asks this page two things:
//   check({ url, text })       what keo can tell from the address alone (keo-linkcheck.js), and whether the person has said not to ask about
//                              this site. Plain data in and out; nothing is fetched.
//   open({ url, clean, trust })  checks the address AGAIN here, refuses a kind that is never opened, and opens the page in a new browser tab
//                              (in the desktop app: in the system's browser, through the app). `clean` opens the address without its tracking
//                              parts; `trust` remembers the site so the warning is skipped next time.
//   trusted() / untrust({ site })   the sites the person said not to ask about, and taking one back.
//
// What the world can and cannot do through this: it cannot open a kind of link that is refused, and it cannot open a page that does not
// pass keo-linkcheck.js. It CAN still ask this page to open an ordinary web address without showing the warning, and the sandboxed frame
// is allowed pop-ups anyway (extension/build.js), so the warning protects a person from the links in what they are reading, not from a
// world that is itself hostile. The tab is opened with no referrer: the site is not told which document, or which extension address, the
// person came from. The list of trusted sites is kept with the identity's other settings (keo-worlds.js), encrypted under it.
(function () {
  'use strict';
  var lc = window.keoLinkCheck;

  function sites() {
    return Promise.resolve().then(function () { return window.keoWorlds.prefsGet(); }).then(function (p) { return lc.cleanSites(p && p.trustedSites); }, function () { return []; });
  }
  function saveSites(list) { return window.keoWorlds.prefsSet({ key: 'trustedSites', value: lc.cleanSites(list) }); }

  function check(a) {
    var res = lc.analyze(a && a.url, a && a.text);
    return sites().then(function (list) { res.skip = lc.trustedHere(res, list); return res; });
  }

  // A mail link goes to the system's mail program: in the desktop app through the app (its windows follow no link), elsewhere through an
  // ordinary link click made by this page (a tab would show an empty page).
  function openMail(url) {
    if (window.keoHost && window.keoHost.available()) return openWeb(url);
    var el = document.createElement('a');
    el.href = url; el.rel = 'noopener noreferrer';
    el.style.display = 'none';
    document.body.appendChild(el);
    try { el.click(); } finally { document.body.removeChild(el); }
    return Promise.resolve();
  }

  function openWeb(url) {
    // the desktop app: its windows follow no link, so it opens the address in the system's browser itself (keo-host.js)
    if (window.keoHost && window.keoHost.available()) {
      return window.keoHost.post('link', { op: 'open', url: url }).then(function (r) { if (!r || r.ok !== true) throw new Error('The app could not open that link.'); });
    }
    if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.create === 'function') return Promise.resolve(chrome.tabs.create({ url: url, active: true })).then(function () {});
    return Promise.reject(new Error('This page cannot open links.'));
  }

  function open(a) {
    var res = lc.analyze(a && a.url, a && a.text);
    if (res.kind === 'blocked') return Promise.reject(new Error('keo does not open that kind of link.'));
    var target = res.kind === 'mail' ? res.url : (a.clean === true && res.cleaned ? res.cleaned : res.url);
    var remember = (a.trust === true && res.kind === 'web' && res.trustable)
      ? sites().then(function (list) { return saveSites([res.reg].concat(list.filter(function (s) { return s !== res.reg; }))); }).catch(function () { /* not signed in: the link still opens */ })
      : Promise.resolve();
    return remember.then(function () {
      return res.kind === 'mail' ? openMail(target) : openWeb(target);
    }).then(function () { return { opened: true }; });
  }

  function trusted() { return sites(); }
  function untrust(a) {
    var site = lc.cleanSite(a && a.site);
    if (!site) return Promise.reject(new Error('Not a site that can be taken back.'));
    return sites().then(function (list) { return saveSites(list.filter(function (s) { return s !== site; })); }).then(function () { return sites(); });
  }

  window.keoLinks = { check: check, open: open, trusted: trusted, untrust: untrust };
})();
