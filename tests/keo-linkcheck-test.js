// Node test for keo-linkcheck.js (what keo can tell about a link from its address): no browser.
// Usage: node keo-linkcheck-test.js
const path = require('path');
const lc = require(path.join(__dirname, '..', 'shell', 'keo-linkcheck.js'));
let passed = 0;
const ok = (name, cond, extra) => { if (!cond) { console.error('FAIL ' + name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 600) : '')); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } };
const codes = (a) => a.finds.map((f) => f.code).sort();
const ch = (n) => String.fromCharCode(n);      // characters that are hard to see in a source file are written as numbers

// ---- an ordinary link
let a = lc.analyze('https://library.example.org/catalogue/1342');
ok('an ordinary https link is a web link with nothing found', a.kind === 'web' && a.finds.length === 0 && a.worst === 'ok', a);
ok('its site, its registrable name and its encryption are read', a.host === 'library.example.org' && a.reg === 'example.org' && a.https === true, a);
ok('it may be trusted, and may skip the warning once its site is in the list', a.trustable === true && lc.trustedHere(a, ['example.org']) === true && lc.trustedHere(a, ['other.org']) === false && lc.trustedHere(a, []) === false);
ok('the pieces for drawing: the name in front of the registrable name is split off', a.parts.hostSub === 'library.' && a.parts.hostReg === 'example.org' && a.parts.path === '/catalogue/1342' && a.parts.scheme === 'https', a.parts);
ok('a bare site (no subdomain) has no front part', lc.analyze('https://example.org/').parts.hostSub === '' && lc.analyze('https://example.org/').parts.hostReg === 'example.org');
ok('upper case in the site is read as lower case', lc.analyze('HTTPS://Library.Example.ORG/x').host === 'library.example.org');
ok('whitespace around an address is ignored', lc.analyze('  https://example.org/a  ').kind === 'web');

// ---- not encrypted, numbers, ports
a = lc.analyze('http://archive.example.org/editions/1887');
ok('plain http is found, and is neither trusted nor skippable', codes(a).join() === 'http' && a.worst === 'warn' && a.trustable === false && !lc.trustedHere(a, ['example.org']), a);
a = lc.analyze('http://192.168.0.7:8080/admin');
ok('a number for a site and an odd port are both found, with http', codes(a).join() === 'http,ip,port', codes(a));
ok('the default port is not odd', lc.analyze('https://example.org:443/').finds.length === 0 && lc.analyze('http://example.org:80/').finds.map((f) => f.code).join() === 'http');
ok('an address written as a number in the other forms is still a number', lc.analyze('http://2130706433/').finds.some((f) => f.code === 'ip') || lc.analyze('http://2130706433/').host === '127.0.0.1');
ok('a site with a bracketed number (ipv6) is found as a number', lc.analyze('https://[::1]:8443/x').finds.some((f) => f.code === 'ip'));

// ---- tracking parts
a = lc.analyze('https://news.example.com/story?id=88&utm_source=newsletter&utm_medium=email&fbclid=IwAR0x93k#top');
ok('tracking parts are found and counted', codes(a).join() === 'tracking' && a.finds[0].title === '3 tracking parts in the address', a.finds);
ok('the cleaned address drops only the tracking parts and keeps the rest, in order, with the place', a.cleaned === 'https://news.example.com/story?id=88#top', a.cleaned);
ok('the pieces mark which parts of the query are tracking', a.parts.query.map((q) => q.text + (q.tracking ? '*' : '')).join('&') === 'id=88&utm_source=newsletter*&utm_medium=email*&fbclid=IwAR0x93k*', a.parts.query);
ok('a link with tracking parts is not skipped even on a trusted site, and cannot be trusted-and-forgotten', lc.trustedHere(a, ['example.com']) === false);
a = lc.analyze('https://shop.example.net/offer?gclid=Cj0KCQ&q=red%20shoes+size&ref=top');
ok('the encoding of the parts that stay is not touched', a.cleaned === 'https://shop.example.net/offer?q=red%20shoes+size&ref=top', a.cleaned);
a = lc.analyze('https://shop.example.net/offer?utm_campaign=x&UTM_Source=y');
ok('when every part is tracking, no question mark is left; names match in any case; the singular is used', a.cleaned === 'https://shop.example.net/offer' && a.finds[0].title === '2 tracking parts in the address', a);
ok('one tracking part says "part"', lc.analyze('https://e.example.org/?fbclid=1').finds[0].title === '1 tracking part in the address');
ok('a link with none has no cleaned address', lc.analyze('https://e.example.org/?id=3').cleaned === null);
ok('a name that only starts like a tracking part is not one', lc.analyze('https://e.example.org/?utm=1&gclidx=2&fbclid_not=3').cleaned === null);

// ---- forwarding and shortened links
a = lc.analyze('https://bit.ly/3xYzAb');
ok('a shortened link is found and forwards', codes(a).join() === 'shortener' && a.forwards === true && a.trustable === false, a);
ok('a shortener is found on a subdomain too, and a lookalike name is not one', lc.analyze('https://www.bit.ly/a').forwards === true && lc.analyze('https://notbit.ly/a').forwards === false);
a = lc.analyze('https://ad.doubleclick.net/click?x=1');
ok('a known click-counting host is found', codes(a).join() === 'tracker-host' && a.forwards === true, a);
a = lc.analyze('https://click.mail.example.com/c/9');
ok('a host that names itself a click counter is found', codes(a).join() === 'tracker-host', a);
ok('a plain two-label host starting with the word is not a click counter', lc.analyze('https://track.example/a').finds.length === 0, lc.analyze('https://track.example/a').finds);
a = lc.analyze('https://promo.example.com/go?c=991&url=https%3A%2F%2Flibrary.example.org%2Fa');
ok('a part that holds another web address is a forward, and says where to', codes(a).join() === 'forwards' && /library\.example\.org/.test(a.finds[0].detail) && a.forwards === true, a.finds);
ok('a part with that name but no web address in it is not a forward', lc.analyze('https://promo.example.com/go?url=home&next=2').forwards === false);
ok('a javascript address in a forward part is not followed or counted as one', lc.analyze('https://promo.example.com/go?url=javascript:alert(1)').forwards === false);

// ---- a name that hides where the link goes
a = lc.analyze('https://library.example.org@files.sketchy.example/login');
ok('a name before the @ is found, and the real site is named', codes(a).join() === 'userinfo' && a.deceptive === true && a.host === 'files.sketchy.example' && /files\.sketchy\.example/.test(a.finds[0].detail) && a.worst === 'bad', a);
ok('...with a password too, and the pieces show it', lc.analyze('https://u:p@example.org/').deceptive === true && lc.analyze('https://u:p@example.org/').parts.userinfo === 'u:p');
ok('an address that is deceptive is never trustable or skippable', a.trustable === false && !lc.trustedHere(a, ['sketchy.example']));
const cyr = 'https://libr' + ch(0x430) + 'ry.example.org/join';
a = lc.analyze(cyr);
ok('a site name with a look-alike letter is found and shown in its real (xn--) form', codes(a).join() === 'lookalike' && a.deceptive === true && /xn--/.test(a.host) && a.worst === 'bad', a);
ok('a name already in the xn-- form is found', lc.analyze('https://xn--xample-9uf.com/').deceptive === true);
ok('an accented letter in a name is found too', lc.analyze('https://caf' + ch(0xe9) + '.example/').deceptive === true);
ok('a lookalike is not skippable', !lc.trustedHere(a, [a.reg]));

// ---- the words of the link
a = lc.analyze('https://promo.adnetwork.example/click?c=991', 'library.example.org');
ok('link text that names another site is found', a.finds.some((f) => f.code === 'text-mismatch') && /library\.example\.org/.test(a.finds.filter((f) => f.code === 'text-mismatch')[0].detail), a.finds);
ok('...and the link cannot then be trusted or skipped', a.trustable === false);
ok('link text for the same site (with www, a path, a scheme) is fine', ['example.org', 'www.example.org', 'https://example.org/page', 'library.example.org/x'].every((t) => !lc.analyze('https://library.example.org/catalogue', t).finds.some((f) => f.code === 'text-mismatch')));
ok('ordinary words are not compared', ['the library catalogue', 'click here', 'e.g.', 'i.e.', 'p. 12', ''].every((t) => !lc.analyze('https://library.example.org/', t).finds.some((f) => f.code === 'text-mismatch')));
ok('a file name in the text is not taken for a site', ['node.js', 'notes.md', 'report.pdf', 'archive.tar.gz'].every((t) => !lc.analyze('https://library.example.org/', t).finds.some((f) => f.code === 'text-mismatch')));
ok('no text at all is fine', !lc.analyze('https://library.example.org/', undefined).finds.some((f) => f.code === 'text-mismatch') && !lc.analyze('https://library.example.org/', null).finds.some((f) => f.code === 'text-mismatch'));

ok('link text of a million characters (from the page) is not read, and the check stays fast', (() => { const t0 = Date.now(); const r = lc.analyze('https://library.example.org/', 'a.'.repeat(500000)); const r2 = lc.analyze('https://library.example.org/', 'a'.repeat(1000000)); return Date.now() - t0 < 500 && !r.finds.some((f) => f.code === 'text-mismatch') && !r2.finds.some((f) => f.code === 'text-mismatch'); })());

// ---- email
a = lc.analyze('mailto:editor@example.org?subject=Chapter%203');
ok('an email link is its own kind, with the address and no web findings', a.kind === 'mail' && a.mailTo === 'editor@example.org' && a.finds.length === 0 && a.reg === 'example.org', a);
ok('an email address with a plus and an encoded sign is read', lc.analyze('mailto:a%2Bb@example.org').mailTo === 'a+b@example.org' && lc.analyze('mailto:a+b@example.org').mailTo === 'a+b@example.org');
ok('an email link with no usable address is blocked', ['mailto:', 'mailto:nobody', 'mailto:a@b', 'mailto:a@b@c.org', 'mailto:a,b@c.org', 'mailto:<x>@c.org'].every((u) => lc.analyze(u).kind === 'blocked'), ['mailto:', 'mailto:nobody', 'mailto:a@b', 'mailto:a@b@c.org', 'mailto:a,b@c.org', 'mailto:<x>@c.org'].map((u) => lc.analyze(u).kind));
ok('an email link is never skippable', lc.trustedHere(a, ['example.org']) === false);

// ---- kinds that are never opened
for (const u of ['javascript:alert(1)', 'JavaScript:alert(1)', '  javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///C:/x', 'vbscript:x', 'blob:null/1234', 'about:blank', 'chrome://settings', 'chrome-extension://abcd/x.html', 'view-source:https://example.org']) {
  const b = lc.analyze(u);
  ok('never opened: ' + u, b.kind === 'blocked' && b.worst === 'bad' && b.finds[0].code === 'blocked' && b.url === '' && /^keo will not open this kind of link$/.test(b.finds[0].title) && / are never opened.$/.test(b.finds[0].detail), b);
}
ok('a scheme with a tab or newline hidden in it is not an address (a browser would read it as a script)', ['java\tscript:alert(1)', 'java\nscript:alert(1)', 'jav&#x09;ascript:alert(1)'].every((u) => lc.analyze(u).kind === 'blocked'));
ok('a space inside an address is not an address', lc.analyze('https://exa mple.org/').kind === 'blocked');
ok('text-direction and zero-width characters are refused', [0x202e, 0x200b, 0x2066, 0xfeff, 0x00ad].slice(0, 4).every((c) => lc.analyze('https://example.org/a' + ch(c) + 'b').kind === 'blocked'));
ok('other kinds of link are refused with the reason', ['ftp://example.org/x', 'sms:+15551234', 'tel:+15551234', 'custom-app://run/1', 'other-app://open'].every((u) => lc.analyze(u).kind === 'blocked'));
ok('no scheme, empty, or a bare "//" address is refused', ['', '   ', 'example.org', '//example.org/x', '/relative/path', 'https:', 'https://', 'http://?x=1'].every((u) => lc.analyze(u).kind === 'blocked'), ['', '   ', 'example.org', '//example.org/x', '/relative/path', 'https:', 'https://', 'http://?x=1'].map((u) => lc.analyze(u).kind));
ok('an address longer than the limit is refused', lc.analyze('https://example.org/' + 'a'.repeat(lc.MAX_URL)).kind === 'blocked' && lc.analyze('https://example.org/' + 'a'.repeat(lc.MAX_URL - 30)).kind === 'web');
ok('a long address is reported as long, not refused', lc.analyze('https://example.org/' + 'a'.repeat(300)).finds.some((f) => f.code === 'long' && f.level === 'info'));
ok('the address kept in the answer is the browser\'s own reading of it (the one that would be opened), not the text as given', lc.analyze('HTTPS://Example.ORG:443/a b'.replace(' ', '%20')).url === 'https://example.org/a%20b');
ok('a refused address gives back no address to open', lc.analyze('javascript:alert(1)').url === '' && lc.analyze('').url === '');

// ---- the registrable name
ok('the registrable name follows a two-part ending', lc.regDomain('www.bbc.co.uk') === 'bbc.co.uk' && lc.regDomain('a.b.example.org') === 'example.org' && lc.regDomain('example.org') === 'example.org' && lc.regDomain('localhost') === 'localhost');

// ---- the trusted list
ok('a site is kept in one form, or not at all', lc.cleanSite(' Example.ORG ') === 'example.org' && lc.cleanSite('a-b.example.org') === 'a-b.example.org' && ['', 'localhost', 'example', 'exa mple.org', '-a.org', 'a-.org', 'https://example.org', 'example.org/', 'exa_mple.org', null, undefined, 12, {}].every((s) => lc.cleanSite(s) === null), ['', 'localhost', 'example', 'https://example.org', 12].map(lc.cleanSite));
ok('the list is cleaned: each valid site once, junk dropped, a list that is not a list is empty, at most the limit', JSON.stringify(lc.cleanSites(['a.org', 'A.ORG', 'bad', 5, 'b.org'])) === '["a.org","b.org"]' && lc.cleanSites('a.org').length === 0 && lc.cleanSites(null).length === 0 && lc.cleanSites(Array.from({ length: 500 }, (_, i) => 'site' + i + '.org')).length === lc.MAX_SITES);
ok('a trusted site skips the warning only for a clean https link: not http, not with tracking parts, not for a mail link, not when blocked', (() => {
  const s = ['example.org'];
  return lc.trustedHere(lc.analyze('https://www.example.org/a'), s) && !lc.trustedHere(lc.analyze('http://www.example.org/a'), s) && !lc.trustedHere(lc.analyze('https://www.example.org/a?fbclid=1'), s) &&
    !lc.trustedHere(lc.analyze('mailto:a@example.org'), s) && !lc.trustedHere(lc.analyze('javascript:1'), s) && !lc.trustedHere(null, s) && !lc.trustedHere(lc.analyze('https://example.org/'), null) && !lc.trustedHere(lc.analyze('https://example.org:8443/'), s);
})());
ok('trusting a site does not trust another site that only ends the same way', !lc.trustedHere(lc.analyze('https://notexample.org/'), ['example.org']) && !lc.trustedHere(lc.analyze('https://example.org.evil.example/'), ['example.org']));

// ---- it never throws, whatever it is given
const junk = [undefined, null, 0, 12, true, {}, [], ['https://example.org'], () => 1, 'x'.repeat(100000), '\u0000', '%', 'https://%', 'https://[', 'http://a..b/', 'https://example.org/%zz', 'https://example.org/?%=%&&&=', '\ud800'];
let threw = null;
for (const j of junk) { try { const r = lc.analyze(j, j); if (!r || (r.kind !== 'web' && r.kind !== 'mail' && r.kind !== 'blocked')) threw = 'bad shape for ' + String(j).slice(0, 20); } catch (e) { threw = String(e).slice(0, 100); } }
ok('nothing it is given makes it throw, and it always answers with a kind', threw === null, threw);
ok('an answer is plain data: it survives a trip through JSON unchanged', (() => { const r = lc.analyze('https://news.example.com/s?utm_source=a'); return JSON.stringify(JSON.parse(JSON.stringify(r))) === JSON.stringify(r); })());

console.log(process.exitCode ? 'FAILED' : 'ALL PASSED (' + passed + ' checks)');
