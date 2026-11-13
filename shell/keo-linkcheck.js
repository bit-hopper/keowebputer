// What keo can tell about a link from its ADDRESS ALONE, before a person follows it out of keo. No storage, no DOM, no network, no keys: pure
// functions, so a Node test can check them. keo-links.js (the shell side) uses it to answer the warning and to open the tab.
//
// analyze(address, linkText)   returns plain data: { kind: 'web' | 'mail' | 'blocked', finds: [{ level: 'bad' | 'warn' | 'info', code, title,
//                              detail }], worst: 'ok' | 'warn' | 'bad', url, host, reg, https, deceptive, forwards, cleaned, trustable,
//                              parts, mailTo }. `linkText` is the words the link was shown with, when there are any (a book's link text).
// trustedHere(analysis, sites) whether a link may skip the warning because its site is one the person said not to ask about again.
// cleanSite(text)              a site as it is kept in the trusted list, or null.
//
// What this must not be used for: deciding that a site is SAFE. It reads the address and nothing else; it cannot see what the page loads,
// what it tracks once open, or where a shortened or forwarding link ends (finding out would mean visiting it, which is what the person has
// not yet agreed to). "Nothing unusual in the address" is all it ever says. The lists below are small and are not a blocklist.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.keoLinkCheck = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_URL = 4096;
  var MAX_SITES = 200;

  // Parts of an address that tell a site who sent the visitor, not what to show. A match is by name, case does not matter.
  var TRACK_PARAM = /^(utm_[a-z0-9_]+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|mc_eid|mc_cid|igshid|yclid|twclid|ttclid|_hsenc|_hsmi|mkt_tok|vero_id|wickedid|s_cid|oly_enc_id|oly_anon_id|ref_src|ref_url)$/i;
  // A part of an address that holds another address to be sent on to.
  var REDIRECT_PARAM = /^(url|u|redirect|redirect_uri|redirect_url|target|dest|destination|to|link|goto|r|next|continue|return|returnto)$/i;
  var SHORTENERS = ['bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 'lnkd.in', 'buff.ly', 'rebrand.ly', 'cutt.ly'];
  var TRACKER_HOSTS = ['doubleclick.net', 'googleadservices.com', 'googlesyndication.com', 'adsrvr.org'];
  // A first label that names what a click-counting service calls itself, on a host with at least one more label.
  var TRACKER_LABELS = /^(click|clicks|track|tracking|trk|redirect|mailtrack)$/i;
  // Kinds of link that are never opened, with the reason a person is told.
  var BLOCKED = {
    javascript: 'It would run a script.', vbscript: 'It would run a script.', data: 'It carries its own page inside the address.',
    file: 'It points at files on a computer, not a website.', blob: 'It points at data held by a page.',
    about: 'It is a browser-internal page.', 'view-source': 'It is a browser-internal page.', chrome: 'It is a browser-internal page.',
    'chrome-extension': 'It points inside a browser extension.', 'moz-extension': 'It points inside a browser extension.'
  };
  // Where the registrable name takes three labels. APPROXIMATE: a proper public-suffix list is a later step, so a name under a suffix that is
  // not here is shown with one label too many in grey, which can make a site look like a subdomain of its own parent. It is never used to
  // decide that two names are the same SITE except in the "link text names another site" and the trusted-site checks, which only err toward asking.
  var TWO_PART_SUFFIX = ['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'org.au', 'net.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'org.br', 'co.za', 'co.in', 'com.cn', 'com.mx', 'com.ar', 'com.tr', 'com.sg', 'com.hk', 'co.kr', 'co.il'];
  // Endings of file names that look like a site name in running text ("node.js", "notes.md"): not compared with where a link goes.
  var FILE_ENDINGS = 'js ts py rb rs go md txt json html htm css png jpg jpeg gif svg pdf zip gz exe doc docx xls xlsx ppt csv xml yml yaml sh bat dll so jar php cpp java'.split(' ');

  function hostIn(h, list) { return list.some(function (x) { return h === x || h.slice(-(x.length + 1)) === '.' + x; }); }

  function regDomain(host) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.indexOf(':') >= 0) return host;
    var l = host.split('.');
    if (l.length <= 2) return host;
    var last2 = l.slice(-2).join('.');
    return TWO_PART_SUFFIX.indexOf(last2) >= 0 ? l.slice(-3).join('.') : last2;
  }

  function decode(s) { try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (e) { return String(s); } }
  function queryKey(pair) { return decode(pair.split('=')[0] || ''); }

  function shorten(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // A site as the trusted list keeps it: a lower-case name made of letters, digits, dots and hyphens, or null.
  function cleanSite(text) {
    var s = String(text == null ? '' : text).trim().toLowerCase();
    return s.length <= 253 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s) ? s : null;
  }

  function blocked(r, title, detail) { r.kind = 'blocked'; r.finds.push({ level: 'bad', code: 'blocked', title: title, detail: detail }); r.worst = 'bad'; return r; }

  function analyze(input, linkText) {
    var raw = String(input == null ? '' : input).trim();
    var r = { kind: 'web', raw: raw.length > 300 ? raw.slice(0, 300) : raw, url: '', finds: [], worst: 'ok', host: '', reg: '', https: false, deceptive: false, forwards: false, cleaned: null, trustable: false, parts: null, mailTo: '' };
    function add(level, code, title, detail) { r.finds.push({ level: level, code: code, title: title, detail: detail }); }
    if (!raw) return blocked(r, 'This is not a valid address', 'There is nothing to open.');
    if (raw.length > MAX_URL) return blocked(r, 'This address is too long', 'keo does not open addresses of more than ' + MAX_URL + ' characters.');
    // Spaces and control characters are dropped silently by a browser when it reads an address ("java\tscript:" becomes a script), and
    // letters that change the direction of text or take no room can make an address read as another one. Neither belongs in a real link.
    if (/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(raw)) return blocked(r, 'This is not a valid address', 'It has spaces, control characters or hidden characters in it, which a real link does not.');
    var m = raw.match(/^([a-z][a-z0-9+.-]*):/i), scheme = m ? m[1].toLowerCase() : '';
    if (!scheme) return blocked(r, 'This is not a valid address', 'It does not start with http:// or https://, so keo cannot tell where it goes.');
    if (Object.prototype.hasOwnProperty.call(BLOCKED, scheme)) return blocked(r, 'keo will not open this kind of link', BLOCKED[scheme] + ' Links that start with “' + scheme + ':” are never opened.');
    if (scheme === 'mailto') {
      var rest = raw.slice(7).split('?')[0], addr = decode(rest.replace(/\+/g, '%2B'));
      if (!/^[^@\s,;<>()\[\]\\"]+@[^@\s,;<>()\[\]\\"]+\.[^@\s,;<>()\[\]\\"]+$/.test(addr)) return blocked(r, 'This is not a valid email address', 'keo will not open it.');
      r.kind = 'mail'; r.mailTo = addr; r.reg = addr.split('@')[1].toLowerCase(); r.url = raw;
      return r;
    }
    if (scheme !== 'http' && scheme !== 'https') return blocked(r, 'keo does not open this kind of link', 'Only web addresses (http, https) and email addresses are opened from inside keo.');
    var u;
    try { u = new URL(raw); } catch (e) { return blocked(r, 'This is not a valid address', 'keo cannot read it, so it will not open it.'); }
    if (!u.hostname) return blocked(r, 'This is not a valid address', 'It names no site.');
    r.url = u.href; r.host = u.hostname.toLowerCase(); r.reg = regDomain(r.host); r.https = u.protocol === 'https:';

    // as written, before the browser turns accented letters into the xn-- form
    var hostWritten = raw.replace(/^[a-z]+:[\/\\]*/i, '').split(/[\/\\?#]/)[0].replace(/^.*@/, '');
    if (u.username || u.password) { r.deceptive = true; add('bad', 'userinfo', 'The address hides where it really goes', 'The part before the @ (“' + shorten(u.username, 60) + '”) is only a name. The link goes to ' + r.host + '.'); }
    if (/[^\x00-\x7f]/.test(hostWritten) || /(^|\.)xn--/.test(r.host)) { r.deceptive = true; add('bad', 'lookalike', 'The site name may be a lookalike', 'It uses letters that can look like others, so it can pass for a site you know. The real name is ' + r.host + '.'); }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(r.host) || r.host.indexOf(':') >= 0) add('warn', 'ip', 'The address is a number, not a site name', 'This often means a device on a network, a router for example, not a public website.');
    if (u.port) add('warn', 'port', 'It uses an unusual port (' + u.port + ')', 'Normal websites do not need this. It is common for devices and test servers.');
    if (!r.https) add('warn', 'http', 'The connection is not encrypted', 'Anyone on the network can read or change this page, and see what you type on it.');
    if (hostIn(r.host, SHORTENERS)) { r.forwards = true; add('warn', 'shortener', 'This is a shortened link', 'The real destination is hidden. keo cannot look it up without visiting it.'); }
    var labels = r.host.split('.');
    if (hostIn(r.host, TRACKER_HOSTS) || (labels.length > 2 && TRACKER_LABELS.test(labels[0]))) { r.forwards = true; add('warn', 'tracker-host', 'It goes through a click tracker', r.host + ' looks like a service that counts clicks before sending you on.'); }

    var pairs = u.search ? u.search.slice(1).split('&').filter(Boolean) : [];
    var tracked = [], fwd = null;
    pairs.forEach(function (p) {
      var k = queryKey(p), v = decode(p.slice(p.indexOf('=') + 1));
      if (TRACK_PARAM.test(k)) tracked.push(k);
      else if (p.indexOf('=') >= 0 && REDIRECT_PARAM.test(k) && /^https?:\/\//i.test(v)) fwd = v;
    });
    if (fwd) { r.forwards = true; add('warn', 'forwards', 'It forwards you to another address', 'After this site, you are sent on to ' + shorten(fwd, 70) + '.'); }
    if (tracked.length) {
      var keep = pairs.filter(function (p) { return !TRACK_PARAM.test(queryKey(p)); });
      r.cleaned = u.protocol + '//' + u.host + u.pathname + (keep.length ? '?' + keep.join('&') : '') + u.hash;
      add('warn', 'tracking', tracked.length + ' tracking ' + (tracked.length === 1 ? 'part' : 'parts') + ' in the address', 'These tell the site who sent you here, for example a newsletter or an ad: ' + tracked.slice(0, 4).join(', ') + (tracked.length > 4 ? ', …' : '') + '. A cleaned link is available.');
    }

    // The words the link was shown with name a site: it should be where the link goes.
    var lt = String(linkText == null ? '' : linkText).trim(), mismatch = false;
    if (lt.length > 300) lt = '';        // words that long are not a site name, and the page chose them: not read at all
    var lm = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+([a-z]{2,24}))(?::\d+)?(?:[\/?#]\S*)?$/i.exec(lt);
    if (lm && FILE_ENDINGS.indexOf(lm[2].toLowerCase()) < 0 && (/^https?:\/\//i.test(lt) || /^www\./i.test(lt) || lt.indexOf('/') >= 0 || lm[2].length >= 3 || lm[1].split('.').length >= 2)) {
      var th = lm[1].toLowerCase();
      if (regDomain(th) !== r.reg) { mismatch = true; add('warn', 'text-mismatch', 'The link text names a different site', 'The text says “' + shorten(th, 60) + '”, but the link goes to ' + r.host + '.'); }
    }
    if (raw.length > 250) add('info', 'long', 'The address is very long', 'Long addresses often carry extra data about you or hide where they go.');

    r.worst = r.finds.some(function (f) { return f.level === 'bad'; }) ? 'bad' : r.finds.some(function (f) { return f.level === 'warn'; }) ? 'warn' : 'ok';
    r.trustable = r.https && !r.deceptive && !r.forwards && !mismatch && cleanSite(r.reg) !== null;

    // for drawing: the pieces of the address in the order they are written
    var hostSub = '', hostReg = r.host;
    if (r.reg && r.host !== r.reg && r.host.slice(-r.reg.length) === r.reg) { hostSub = r.host.slice(0, r.host.length - r.reg.length); hostReg = r.reg; }
    r.parts = {
      scheme: u.protocol.slice(0, -1), userinfo: u.username ? u.username + (u.password ? ':' + u.password : '') : '', hostSub: hostSub, hostReg: hostReg, port: u.port || '',
      path: u.pathname, query: pairs.map(function (p) { return { text: p, tracking: TRACK_PARAM.test(queryKey(p)) }; }), hash: u.hash
    };
    return r;
  }

  // A link may skip the warning only when its site was trusted, it is encrypted, and nothing in the address is out of the ordinary:
  // no hidden name, no forwarding, no tracking service, no link text for another site, and nothing the check called bad or odd.
  function trustedHere(a, sites) {
    if (!a || a.kind !== 'web' || !a.trustable || a.worst !== 'ok') return false;
    return Array.isArray(sites) && sites.indexOf(a.reg) >= 0;
  }

  // The list as it is kept: only valid sites, each once, at most MAX_SITES.
  function cleanSites(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (x) { var s = cleanSite(x); if (s && out.indexOf(s) < 0 && out.length < MAX_SITES) out.push(s); });
    return out;
  }

  return { analyze: analyze, trustedHere: trustedHere, cleanSite: cleanSite, cleanSites: cleanSites, regDomain: regDomain, MAX_URL: MAX_URL, MAX_SITES: MAX_SITES };
});
