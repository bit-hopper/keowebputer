// Links that leave keo (shell: keo-linkcheck.js, keo-links.js, bridge ops link.*; kernel: lively.identity.LinkWarning, the document viewer in
// lively.data.DocumentUpload). Checks, with the real viewer (a web page dropped on the world), real mouse clicks and a local HTTPS server
// that the browser is pointed at by a host rule (no request leaves the machine):
//   the shell: the address check and the refusals through the bridge; link.open opens a new tab, with no referrer, with or without the
//   tracking parts; a kind that is never opened is refused; a site is trusted only for a clean link and can be taken back; bad values
//   for the setting are refused.
//   the window: a click on a link in a document shows "Leaving keo" with the site, what was found and the right buttons, sized to its
//   content; the safe button has the focus for a disguised link; Esc, Cancel and the close button open nothing; Open cleaned link and
//   Open as written open what they say; "Don't ask again" by a real click makes the next click open the page at once; an unencrypted
//   link, a disguised link, a link whose text names another site, an email link and a very long address each read as they should;
//   a second link replaces the first window; a link that is not an outside address does nothing; Show full address grows the window.
//   hostile pages: a page with a script, a handler, a form, a frame, a refresh and a base address changes nothing in the world; the frame
//   gets one script, ours, and its policy allows no other; the page cannot reach the world; what the page can say (a number) is looked up
//   in the viewer's own list, so a number out of range, a text, a message from anywhere but the frame and a made-up address all open nothing,
//   or only a link the document really has; the nonce in the policy lets our script run and stops one without it; without keo's shell the
//   frame is as closed as before.
// SYNTHETIC drops only (a DataTransfer built in the page). The "Open email program" button is never clicked (it would start a mail program).
// Usage: node keo-links-test.js <repo root> <extension folder> <work dir>
const fs = require('fs');
const path = require('path');
const https = require('https');
const cp = require('child_process');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 1400) : '')); if (!ok) failed++; }
const worldFrame = (page) => page.frames().find((f) => /world\.html$/.test(f.url()));
async function waitForWorld(page, kind, name) {
  let frame = null;
  for (let i = 0; i < 200; i++) {
    frame = worldFrame(page);
    if (frame) { try { if (await frame.evaluate(([k, n]) => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind === k && (!n || window.keo.init.startup.name === n)), [kind, name || null])) break; } catch (e) {} }
    frame = null; await sleep(300);
  }
  if (!frame) throw new Error('the world did not start as ' + kind);
  await sleep(2500);
  return frame;
}
const keoCall = (frame, op, args) => frame.evaluate(([o, a]) => window.keo.call(o, a, 60000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [op, args || {}]);
async function until(fn, ms) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > (ms || 10000)) return v; await sleep(200); } }

// a throwaway certificate for the local server, made in the work dir (never kept in the repository)
function makeCert() {
  const key = path.join(WORK, 'links-key.pem'), cert = path.join(WORK, 'links-cert.pem');
  const r = cp.spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=link.test', '-addext', 'subjectAltName=DNS:link.test', '-days', '2'], { encoding: 'utf8', env: Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1' }) });
  if (r.status !== 0) throw new Error('openssl could not make a certificate: ' + (r.stderr || r.error || '').toString().slice(0, 300));
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const LONG = 'https://link.test/' + 'a-very-long-path-segment-'.repeat(12) + 'end';
const HTML = '<!doctype html><html><head><title>t</title><script>window.PWNED = 1</script><meta http-equiv="refresh" content="0;url=https://link.test/refresh"><base href="https://link.test/base/"></head>' +
  '<body onload="window.PWNED = 2"><h1>Reading notes</h1><p>See <a href="https://link.test/catalogue?id=5&utm_source=mail&fbclid=zz">the catalogue</a>, the <a href="https://link.test/clean/page">clean page</a>, ' +
  'an <a href="http://link.test/old">older edition</a>, <a href="https://library.example.org@link.test/login">sign in here</a>, <a href="mailto:editor@example.org?subject=Hi">editor@example.org</a>, ' +
  '<a href="javascript:window.PWNED=3">bad one</a>, <a href="#end">in page</a>, <a href="' + LONG + '">long one</a> and <a href="https://promo.adnetwork.example/x">library.example.org</a>. ' +
  '<img src="x" onerror="window.PWNED = 4"><form action="https://link.test/post"><input name="q"><button>go</button></form><iframe src="https://link.test/frame"></iframe>' +
  '<span onclick="window.PWNED = 5">click me</span></p>' + Array.from({ length: 60 }, (_, i) => '<p>Filler line ' + (i + 1) + '</p>').join('') + '<p id="end">The end</p></body></html>';

const MAKE = async (html) => {
  const d = window.__d = { files: {} };
  d.files.page = new File([new TextEncoder().encode(html)], 'links.html', { type: 'text/html' });
  return true;
};
const DROP = ([key, x, y]) => {
  const dt = new DataTransfer(); dt.items.add(window.__d.files[key]);
  const el = document.elementFromPoint(x, y);
  const mk = (type) => new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y });
  el.dispatchEvent(mk('dragenter')); el.dispatchEvent(mk('dragover')); el.dispatchEvent(mk('drop'));
  return true;
};
// the document box, put where it covers the left of the world and no more
const PLACE = () => {
  let m = null; $world.withAllSubmorphsDo((x) => { if (x.shape && x.shape.fileHandle === 'keo:local' && x.shape.mime === 'text/html') m = x; });
  if (!m) return false;
  m.setExtent(pt(600, 420)); m.setPosition(pt(20, 90));
  return true;
};
// the warning window as it is now: what it says, what it offers and how big it is
const WINDOW = () => {
  const w = $world.submorphs.filter((m) => m.name === 'LinkWarning')[0];
  const all = $world.submorphs.filter((m) => m.name === 'LinkWarning').length;
  if (!w) return null;
  const r = document.querySelector('.lw-root'); if (!r) return { all, noRoot: true };
  const view = w.targetMorph || w.get('linkWarningContent');
  const txt = (sel) => [...r.querySelectorAll(sel)].map((e) => e.textContent.trim());
  const ab = document.activeElement;
  return { all, title: (w.renderContext().morphNode.querySelector('.window-title') || {}).textContent || '', host: ((r.querySelector('.lw-host') || {}).textContent || '').trim(),
    head: ((r.querySelector('.lw-head') || {}).innerText || '').trim(), summary: ((r.querySelector('.lw-summary') || {}).textContent || '').replace(/^[a-z_]+/, '').trim(),
    finds: txt('.lw-find b'), findClasses: [...r.querySelectorAll('.lw-find')].map((e) => e.className.replace('lw-find ', '')),
    buttons: [...r.querySelectorAll('.lw-btns button')].map((b) => ({ t: b.textContent.trim(), c: b.className.replace('lw-b ', '') })),
    tools: txt('.lw-tools button'), chip: txt('.lw-chip').join('|'), trust: !!r.querySelector('[data-el=trust]'), trustText: ((r.querySelector('.lw-trust') || {}).textContent || '').trim(),
    addr: ((r.querySelector('.lw-addr') || {}).textContent || '').trim(), marks: [...r.querySelectorAll('.lw-addr mark')].map((e) => e.textContent), uiMark: ((r.querySelector('.lw-addr .lw-ui') || {}).textContent || ''),
    src: ((r.querySelector('.lw-src') || {}).textContent || ''), limits: ((r.querySelector('.lw-limits') || {}).innerText || ''), error: ((r.querySelector('.lw-err') || {}).textContent || ''),
    active: ab && ab.closest && ab.closest('.lw-root') ? ab.textContent.trim() : null,
    winH: Math.round(w.getExtent().y), viewH: Math.round(view.getExtent().y), rootH: Math.ceil(r.getBoundingClientRect().height), winW: Math.round(w.getExtent().x),
    onScreen: (() => { const b = w.renderContext().shapeNode.getBoundingClientRect(); return b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight; })() };
};

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const seen = [];                      // what reached the local server: { url, referer, origin }
  const tls = makeCert();
  const srv = https.createServer(tls, (req, res) => {
    if (req.url !== '/favicon.ico') seen.push({ url: req.url, referer: req.headers.referer || null, origin: req.headers.origin || null });
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>landed</title><p>landed</p>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-links-' + Date.now()), {
    headless: false, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--ignore-certificate-errors',
      `--host-resolver-rules=MAP link.test 127.0.0.1:${port}, MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND`] });
  await sleep(2500);
  try {
    const page = await ctx.newPage();
    const errors = [], outside = [], tabs = [];
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    page.on('request', (rq) => { const u = rq.url(); if (!/^(chrome-extension|blob|data|about):/.test(u) && !/youtube\.com\/iframe_api$/.test(u)) outside.push(u.slice(0, 100)); });
    ctx.on('page', (p) => { if (p !== page) tabs.push(p); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    await page.goto(`chrome-extension://${ID}/start.html`);
    let frame = await waitForWorld(page, 'gate');
    await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }));
    await keoCall(frame, 'world.go', { kind: 'enter' }).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    await keoCall(frame, 'world.go', { kind: 'blank', name: 'Link room' }).catch(() => {});
    frame = await waitForWorld(page, 'blank', 'Link room');
    await frame.evaluate(() => new Promise((res) => lively.require('lively.identity.LinkWarning').toRun(res)));

    // A new tab is closed again as soon as it has been seen: a page in the background takes no input, and the next click is on this one.
    const nextTab = async (before) => { const t = await until(() => tabs.length > before, 8000); const url = t ? tabs[before].url() : null; await sleep(400); if (tabs[before]) { try { await tabs[before].close(); } catch (e) {} } await page.bringToFront(); return t ? { url } : null; };
    const opened = () => tabs.length;
    const win = () => frame.evaluate(WINDOW);
    // (the window follows its content a moment after it is drawn, so a reading is taken once the window has the size of what it shows)
    const fits = (w) => w.viewH === w.rootH && Math.abs(w.winH - (w.rootH + 25)) <= 1;
    const winIs = async (fn, ms) => { const v = await until(async () => { const w = await win(); return w && fn(w) && fits(w) ? w : null; }, ms || 6000); return v; };
    const noWindow = async () => { await sleep(1500); return (await win()) === null; };
    const settle = async () => { await sleep(700); };

    // ================================================================== the shell, through the bridge
    let r = await keoCall(frame, 'link.check', { url: 'https://link.test/page?id=1' });
    check('link.check: a clean https address is a web link with nothing found, and is not skipped', r.ok && r.r.kind === 'web' && r.r.finds.length === 0 && r.r.skip === false && r.r.reg === 'link.test', r);
    r = await keoCall(frame, 'link.check', { url: 'javascript:alert(1)' });
    check('link.check: a script address is refused with a reason', r.ok && r.r.kind === 'blocked' && r.r.url === '' && /never opened/.test(r.r.finds[0].detail), r);
    r = await keoCall(frame, 'link.check', { url: 'mailto:editor@example.org' });
    check('link.check: an email address is its own kind', r.ok && r.r.kind === 'mail' && r.r.mailTo === 'editor@example.org', r);
    r = await keoCall(frame, 'link.open', { url: 'javascript:alert(1)' });
    const before0 = opened();
    check('link.open: a kind that is never opened is refused, and no tab opens', !r.ok && /does not open that kind/.test(r.e) && opened() === before0, [r, opened()]);
    r = await keoCall(frame, 'link.open', { url: 'data:text/html,<b>x</b>' });
    check('link.open: a data address is refused too', !r.ok && opened() === before0, r);

    let b = opened();
    r = await keoCall(frame, 'link.open', { url: 'https://link.test/opened?a=1&utm_source=mail', clean: true });
    let t = await nextTab(b);
    check('link.open (clean): a new tab opens', r.ok && r.r.opened === true && !!t, [r, t]);
    let hit = await until(() => seen.find((s) => s.url.indexOf('/opened') === 0));
    check('link.open (clean): the site was asked for the address without its tracking part', !!hit && hit.url === '/opened?a=1', seen);
    check('link.open: the site was not told where the person came from (no referrer, no origin)', !!hit && hit.referer === null && hit.origin === null, hit);
    b = opened();
    r = await keoCall(frame, 'link.open', { url: 'https://link.test/aswritten?a=1&utm_source=mail' });
    t = await nextTab(b);
    hit = await until(() => seen.find((s) => s.url.indexOf('/aswritten') === 0));
    check('link.open (as written): the tracking part is kept', r.ok && !!t && !!hit && hit.url === '/aswritten?a=1&utm_source=mail', [r, hit]);

    // trusting a site
    r = await keoCall(frame, 'link.open', { url: 'https://x@link.test/disguised', trust: true });   // a disguised link: opens, is never remembered
    await nextTab(opened());
    check('trust: a disguised link does not add its site, even when asked', (await keoCall(frame, 'link.trusted')).r.length === 0);
    b = opened(); await keoCall(frame, 'link.open', { url: 'https://link.test/trustme', trust: true }); await nextTab(b);
    check('trust: a clean https link adds its site when asked', JSON.stringify((await keoCall(frame, 'link.trusted')).r) === '["link.test"]');
    r = await keoCall(frame, 'link.check', { url: 'https://link.test/any' });
    check('trust: a clean link to that site now skips the warning', r.r.skip === true, r);
    check('trust: but not one with a tracking part, one that forwards, one that is disguised, or an email', (await Promise.all(['https://link.test/a?utm_source=x', 'https://bit.ly/x', 'https://u@link.test/a'].map((u) => keoCall(frame, 'link.check', { url: u })))).every((x) => x.r.skip === false));
    check('trust: and not another site that only ends the same way', (await keoCall(frame, 'link.check', { url: 'https://notlink.test/a' })).r.skip === false);
    const prefs = await keoCall(frame, 'prefs.get');
    check('trust: the list is kept with the identity\'s settings', prefs.ok && JSON.stringify(prefs.r.trustedSites) === '["link.test"]', prefs);
    r = await keoCall(frame, 'prefs.set', { key: 'trustedSites', value: ['ok.example', 'not a site!'] });
    check('trust: the setting refuses a list with something that is not a site', !r.ok, r);
    r = await keoCall(frame, 'link.untrust', { site: '  ' });
    check('trust: taking back something that is not a site is refused', !r.ok, r);
    r = await keoCall(frame, 'link.untrust', { site: 'link.test' });
    check('trust: a site is taken back, and the warning is asked for again', r.ok && r.r.length === 0 && (await keoCall(frame, 'link.check', { url: 'https://link.test/any' })).r.skip === false, r);

    // ================================================================== the real viewer
    await frame.evaluate(MAKE, HTML);
    await frame.evaluate(DROP, ['page', 40, 70]);
    await until(() => frame.evaluate(PLACE), 15000);
    await sleep(1500);
    // (a click on a link to a place in the same page makes the frame's address "about:srcdoc#end")
    const inner = () => frame.childFrames().find((f) => /^about:srcdoc/.test(f.url()) || /^blob:/.test(f.url()));
    const link = (text) => inner().locator('a', { hasText: text }).first();
    const press = async (text) => { await link(text).click({ timeout: 8000 }); };
    const docInfo = await until(async () => { const i = inner(); if (!i) return null; try { return await i.evaluate(() => ({ links: document.querySelectorAll('a[data-ext]').length, scripts: [...document.querySelectorAll('script')].map((s) => ({ nonce: !!s.nonce, len: s.textContent.length })), csp: document.querySelector('meta[http-equiv]').content })); } catch (e) { return null; } }, 15000);
    const attr = await frame.evaluate(() => { const f = document.querySelector('iframe'); return { sandbox: f && f.getAttribute('sandbox'), pwned: window.PWNED || null }; });

    // ---- the page is hostile, and the world is unharmed
    // (what a script in the page did is read in the frame itself: a page cannot set a property on its parent, so a probe there proves nothing)
    const state = await inner().evaluate(() => ({ pwned: typeof window.PWNED, handlers: [...document.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length,
      elements: ['form', 'input', 'button', 'iframe', 'meta[http-equiv=refresh]', 'base', 'img', 'object', 'embed'].filter((s) => document.querySelector(s)), hrefs: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')) }));
    check('hostile page: nothing in it ran or survived in the frame (no PWNED, no handler attribute, no form, frame, refresh, base or picture), and the world is untouched', attr.pwned === null && state.pwned === 'undefined' && state.handlers === 0 && state.elements.length === 0 && state.hrefs.join() === '#end' && (await frame.evaluate(() => window.PWNED === undefined && !document.querySelector('base'))), [attr, state]);
    check('hostile page: the frame lets scripts run and nothing else (no same-origin, forms, popups or top navigation)', attr.sandbox === 'allow-scripts', attr);
    check('hostile page: the one script in it is ours, it carries the nonce, and the policy names that nonce and allows no other script', !!docInfo && docInfo.scripts.length === 1 && docInfo.scripts[0].nonce === true && docInfo.scripts[0].len < 1400 && /default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-[0-9a-f]{32}'$/.test(docInfo.csp), docInfo);
    check('hostile page: only the outside web and email links of the document can be clicked (7 of its 9 links), not the script link and not the in-page one', !!docInfo && docInfo.links === 7, docInfo && docInfo.links);
    const reach = await inner().evaluate(() => { try { return 'reached ' + typeof parent.document.body; } catch (e) { return 'blocked ' + e.name; } });
    check('hostile page: the frame cannot reach into the world (a script run in it is stopped by the browser)', /^blocked/.test(reach), reach);

    // a script without the nonce is stopped, with it is allowed: the layer that matters if the cleaning of a page ever failed
    const layer = await frame.evaluate(async () => {
      const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.style.cssText = 'position:fixed;left:-500px;width:10px;height:10px';
      // the pages report by message (a page cannot write to its parent)
      const got = []; const on = (e) => { if (e.source === f.contentWindow) got.push(e.data); }; window.addEventListener('message', on);
      f.srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-abc123\'"><script>parent.postMessage("a", "*")</script><img src="x" onerror="parent.postMessage(\'b\', \'*\')"><body onload="parent.postMessage(\'c\', \'*\')"><script nonce="abc123">parent.postMessage("d", "*")</script>';
      document.body.appendChild(f); await new Promise((r) => setTimeout(r, 1200)); f.remove(); window.removeEventListener('message', on);
      return { a: got.indexOf('a') >= 0, b: got.indexOf('b') >= 0, c: got.indexOf('c') >= 0, d: got.indexOf('d') >= 0 };
    });
    check('hostile page: a script with no nonce, a handler on a picture and a handler on the body do not run; the one with the nonce does (so this test can see a script run)', layer.a === false && layer.b === false && layer.c === false && layer.d === true, layer);

    // without keo's shell the frame is as closed as it was
    const closed = await frame.evaluate(async () => {
      await new Promise((res) => lively.require('lively.data.DocumentUpload').toRun(res));
      const saved = window.keo; window.keo = undefined;
      let box; try { box = lively.data.FileUpload.buildDocumentContainer(new TextEncoder().encode('<a href="https://link.test/x">x</a>'), { type: 'text/html', name: 'c.html' }); } finally { window.keo = saved; }
      await new Promise((r) => setTimeout(r, 400));
      const f = box.querySelector('iframe'); const out = { sandbox: f.getAttribute('sandbox'), script: /<script/.test(f.getAttribute('srcdoc')), csp: /script-src/.test(f.getAttribute('srcdoc')) };
      return out;
    });
    check('without the shell: the frame has an empty sandbox, no script and no script allowance', closed.sandbox === '' && closed.script === false && closed.csp === false, closed);

    // ---- a click on a link
    await press('the catalogue');
    let w = await winIs((x) => /link\.test/.test(x.host));
    check('a click on a link in the document shows the warning window, titled "Leaving keo"', !!w && /Leaving keo/.test(w.title) && w.all === 1, w);
    check('it names the site, says it is encrypted, and shows the address with the tracking parts marked', !!w && w.host === 'link.test' && w.chip === 'lockEncrypted' && /link\.test\/catalogue\?id=5&utm_source=mail&fbclid=zz$/.test(w.addr) && JSON.stringify(w.marks) === '["utm_source=mail","fbclid=zz"]', w);
    check('it says what was found: two tracking parts, as a warning', !!w && w.summary === '1 thing to know' && JSON.stringify(w.finds) === '["2 tracking parts in the address"]' && w.findClasses[0] === 'warn', w);
    check('it always says that only the address was checked and that the site is not told where the person came from', !!w && /keo checked the address only/.test(w.limits) && /cannot see what the page loads, or whether the site is safe/.test(w.limits) && /does not tell the site which document you came from/.test(w.limits), w && w.limits);
    check('it names where the link was (the document) and offers "Don\'t ask again for link.test"', !!w && w.src === 'Link in: links.html' && w.trust && /Don.t ask again for\s*link\.test/.test(w.trustText), w);
    check('the buttons: Cancel, Open as written, and Open cleaned link as the main one (green); the address can be copied', !!w && JSON.stringify(w.buttons.map((x) => x.t)) === '["Cancel","Open as written","Open cleaned link"]' && w.buttons[2].c === 'go' && w.tools.indexOf('Copy address') >= 0, w && w.buttons);
    check('the main button has the focus', !!w && w.active === 'Open cleaned link', w && w.active);
    check('the window is as tall as what it shows (the window is the content plus its title bar; the content pane is exactly the content), and it is on screen', !!w && w.viewH === w.rootH && Math.abs(w.winH - (w.rootH + 25)) <= 1 && w.winW === 440 && w.onScreen, w && [w.winH, w.viewH, w.rootH, w.winW, w.onScreen]);

    // Esc
    b = opened(); const sn0 = seen.length;
    await page.keyboard.press('Escape'); await settle();
    check('Esc closes the window and nothing opens', (await win()) === null && opened() === b && seen.length === sn0, [await win(), opened(), seen.length]);

    // Cancel
    await press('the catalogue'); w = await winIs((x) => x.host === 'link.test');
    await frame.locator('.lw-root [data-act=cancel]').click(); await settle();
    check('Cancel closes the window and nothing opens', !!w && (await win()) === null && opened() === b && seen.length === sn0, [await win(), opened(), seen.length]);

    // the close button of the window
    await press('the catalogue'); w = await winIs((x) => x.host === 'link.test');
    const controls = await frame.evaluate(() => { const win = $world.submorphs.filter((m) => m.name === 'LinkWarning')[0]; const n = win.renderContext().morphNode; n.setAttribute('data-lw', '1'); return [...n.querySelectorAll('.WindowControl')].map((c) => c.textContent.trim()); });
    await frame.locator('[data-lw="1"] .WindowControl', { hasText: 'close' }).click(); await settle();
    check('the close button of the window closes it and nothing opens', (await win()) === null && opened() === b && seen.length === sn0, [controls, await win()]);

    // Open cleaned link
    await press('the catalogue'); await winIs((x) => x.host === 'link.test');
    b = opened(); await frame.locator('.lw-root [data-act=open-clean]').click();
    t = await nextTab(b);
    hit = await until(() => seen.find((s) => s.url.indexOf('/catalogue') === 0));
    check('Open cleaned link opens the site with the tracking parts left off, and the window goes', !!t && !!hit && hit.url === '/catalogue?id=5' && (await win()) === null, [t, hit, await win()]);
    seen.length = 0;

    // Open as written
    await press('the catalogue'); await winIs((x) => x.host === 'link.test');
    b = opened(); await frame.locator('.lw-root [data-act=open]').click();
    t = await nextTab(b);
    hit = await until(() => seen.find((s) => s.url.indexOf('/catalogue') === 0));
    check('Open as written opens the address as it is, tracking parts included', !!t && !!hit && hit.url === '/catalogue?id=5&utm_source=mail&fbclid=zz' && hit.referer === null, [t, hit]);
    seen.length = 0;

    // a clean link: Open is the green main button, and the box can be ticked
    await press('clean page'); w = await winIs((x) => x.host === 'link.test');
    check('a clean https link: nothing unusual, the main button is Open, there is nothing to clean', !!w && w.summary === 'Nothing unusual in the address' && w.finds.length === 0 && JSON.stringify(w.buttons.map((x) => x.t)) === '["Cancel","Open"]' && w.buttons[1].c === 'go' && w.active === 'Open' && w.trust, w);
    await frame.locator('.lw-root [data-el=trust]').click();
    check('"Don\'t ask again" is ticked by a real click', await frame.evaluate(() => document.querySelector('.lw-root [data-el=trust]').checked));
    b = opened(); await frame.locator('.lw-root [data-act=open]').click();
    t = await nextTab(b);
    hit = await until(() => seen.find((s) => s.url === '/clean/page'));
    check('Open with it ticked opens the page, and the site is trusted', !!t && !!hit && JSON.stringify((await keoCall(frame, 'link.trusted')).r) === '["link.test"]', [t, hit]);
    seen.length = 0;
    b = opened(); await press('clean page');
    t = await nextTab(b);
    hit = await until(() => seen.find((s) => s.url === '/clean/page'));
    check('the next click on a link to that site opens the page at once, with no window', !!t && !!hit && (await win()) === null, [t, hit, await win()]);
    seen.length = 0;
    await press('the catalogue'); w = await winIs((x) => x.host === 'link.test');
    check('but a link to it with tracking parts still asks', !!w && w.finds.length === 1, w);
    await page.keyboard.press('Escape'); await settle();
    await keoCall(frame, 'link.untrust', { site: 'link.test' });

    // not encrypted
    await press('older edition'); w = await winIs((x) => x.host === 'link.test');
    check('an unencrypted link: marked "Not encrypted", one thing to know, Open anyway, and no "Don\'t ask again"', !!w && w.chip === 'lock_openNot encrypted' && w.summary === '1 thing to know' && JSON.stringify(w.finds) === '["The connection is not encrypted"]' && w.buttons[1].t === 'Open anyway' && w.buttons[1].c === '' && !w.trust, w);
    await page.keyboard.press('Escape'); await settle();

    // disguised
    await press('sign in here'); w = await winIs((x) => x.host === 'link.test');
    check('a disguised link names the real site (not the name before the @), shows that name in red, and is marked as bad', !!w && w.host === 'link.test' && w.uiMark === 'library.example.org@' && w.summary === '1 thing to know' && w.findClasses[0] === 'bad' && /hides where it really goes/.test(w.finds[0]), w);
    check('for a disguised link the safe button is the main one and has the focus, and Open anyway is the cautious one; nothing to trust', !!w && w.buttons[0].t === 'Don’t open' && w.buttons[0].c === 'go' && w.buttons[1].t === 'Open anyway' && w.buttons[1].c === 'risk' && w.active === 'Don’t open' && !w.trust, w);
    await page.keyboard.press('Escape'); await settle();

    // link text for another site
    await press('library.example.org'); w = await winIs((x) => /adnetwork/.test(x.host));
    check('link text that names another site is called out', !!w && w.finds.some((x) => /names a different site/.test(x)) && !w.trust, w);
    await page.keyboard.press('Escape'); await settle();

    // email
    await press('editor@example.org'); w = await winIs((x) => /editor@example\.org/.test(x.host));
    check('an email link: the window says it starts an email, shows the address and offers the email program; it is not opened here', !!w && /Open your email program/.test(w.title) && /Open email program/.test(w.buttons.map((x) => x.t).join('|')) && /starts an email/.test(w.head) && w.tools.indexOf('Copy email address') >= 0 && w.finds.length === 0 && !w.trust, w);
    await page.keyboard.press('Escape'); await settle();

    // a very long address
    await press('long one'); w = await winIs((x) => /link\.test/.test(x.host));
    const h1 = w && w.winH;
    check('a long address is shown in two lines, with "Show full address"', !!w && w.tools.indexOf('Show full address') >= 0 && w.viewH === w.rootH, w && [w.tools, w.viewH, w.rootH, w.winH]);
    await frame.locator('.lw-root [data-act=more]').click(); await settle();
    const w2 = await win();
    check('Show full address makes the window taller, to fit all of it', !!w2 && w2.winH > h1 && w2.viewH === w2.rootH && w2.tools.indexOf('Show less') >= 0 && w2.addr.length > 300, w2 && [h1, w2.winH, w2.tools]);
    await frame.locator('.lw-root [data-act=more]').click(); await settle();
    const w3 = await win();
    check('Show less takes it back', !!w3 && w3.winH === h1, w3 && [h1, w3.winH]);

    // copy
    await frame.locator('.lw-root [data-act=copy]').first().click(); await settle();
    check('Copy address says it copied', await frame.evaluate(() => document.querySelector('.lw-root [data-act=copy]').textContent) === 'Copied');
    let clip = null; try { await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'chrome-extension://' + ID }); clip = await page.evaluate(() => navigator.clipboard.readText()); } catch (e) { clip = 'unreadable: ' + String(e).slice(0, 60); }
    if (/^unreadable/.test(String(clip))) console.log('NOTE  the system clipboard could not be read here, so what was copied is UNVERIFIED (' + clip + ')');
    else check('what was copied is the address (read back from the system clipboard)', clip === LONG, clip && clip.slice(0, 80));

    // a second link replaces the window
    await frame.evaluate(() => lively.identity.LinkWarning.go('http://link.test/second', { source: 'a test' })); await sleep(1500);
    w = await win();
    check('a second link shown while a window is up replaces what it showed (one window only)', !!w && w.all === 1 && /link\.test/.test(w.host) && /second/.test(w.addr) && w.src === 'Link in: a test', w);
    await page.keyboard.press('Escape'); await settle();

    // things that are not outside addresses
    b = opened();
    await press('bad one'); await settle();
    check('a script link in a document does nothing when clicked', (await win()) === null && opened() === b && (await frame.evaluate(() => window.PWNED === undefined)), [await win(), opened()]);
    await press('in page'); await settle();
    check('a link to a place in the same page does not ask anything', (await win()) === null && opened() === b);
    // (on the build before this work, this click left the frame on a "blocked" error page)
    const place = await inner().evaluate(() => ({ url: location.href.slice(0, 20), h1: (document.querySelector('h1') || {}).textContent || document.body.innerText.slice(0, 60), y: Math.round(window.scrollY), endTop: Math.round(document.getElementById('end').getBoundingClientRect().top) })).catch((e) => ({ err: String(e).slice(0, 80) }));
    check('a link to a place in the same page takes the document to that place and leaves the frame working', /^about:srcdoc/.test(place.url || '') && place.h1 === 'Reading notes' && place.y > 300 && place.endTop >= 0 && place.endTop < 380, place);

    // blocked kinds, called directly
    await frame.evaluate(() => lively.identity.LinkWarning.go('javascript:alert(1)', {})); await sleep(1200);
    w = await win();
    check('a script address given to the warning gives a window that says it will not open it, with only a Close button', !!w && /Link blocked/.test(w.title) && JSON.stringify(w.buttons.map((x) => x.t)) === '["Close"]' && /will not open this link/.test(w.head) && w.findClasses[0] === 'bad', w);
    await frame.locator('.lw-root [data-act=cancel]').click(); await settle();

    // ---- what the page says is checked by the viewer
    const say = (m) => { const i = inner(); if (!i) throw new Error('no document frame; frames are ' + JSON.stringify(frame.childFrames().map((f) => f.url().slice(0, 40)))); return i.evaluate((x) => parent.postMessage(x, '*'), m); };
    b = opened();
    for (const m of [{ keoLink: 1, i: 999 }, { keoLink: 1, i: -1 }, { keoLink: 1, i: 0.5 }, { keoLink: 1, i: '0' }, { keoLink: 1 }, { keoLink: 2, i: 0 }, 'link', null, { keoLink: 1, i: 1e9 }]) await say(m);
    await sleep(1500);
    check('messages from the frame that are not a link number in range open nothing (out of range, negative, fractional, a text, missing, wrong kind)', (await win()) === null && opened() === b, [await win()]);
    await say({ keoLink: 1, i: 0, href: 'https://evil.example/steal', url: 'https://evil.example/x', text: 'trusted' });
    w = await winIs((x) => x.host);
    check('a message with an address in it is read as its number only: the window is for the document\'s own link', !!w && w.host === 'link.test' && !/evil/.test(w.addr + w.src + w.finds.join()), w);
    await page.keyboard.press('Escape'); await settle();
    await frame.evaluate(() => window.postMessage({ keoLink: 1, i: 0 }, '*')); await sleep(1500);
    check('a message from anywhere but the frame is ignored', (await win()) === null);

    // ---- the list of trusted sites, from the Identity menu
    b = opened(); await keoCall(frame, 'link.open', { url: 'https://link.test/trusted-one', trust: true }); await nextTab(b);
    const entry = await frame.evaluate(() => { const e = $world.get('IdentityMenuBarEntry'); const id = e && e.morphMenuItems().find((i) => i[0] === 'Identity'); return id ? id[1].map((i) => i[0]) : null; });
    check('the Identity menu has "Trusted sites ..."', !!entry && entry.indexOf('Trusted sites ...') >= 0, entry);
    await frame.evaluate(() => { const e = $world.get('IdentityMenuBarEntry'); const id = e.morphMenuItems().find((i) => i[0] === 'Identity')[1]; id.find((i) => i[0] === 'Trusted sites ...')[1](); });
    const sitesWin = () => frame.evaluate(() => { const w = $world.submorphs.filter((m) => m.name === 'TrustedSites')[0]; if (!w) return null; const r = document.querySelector('.lw-root'); const view = w.targetMorph || w.get('trustedSitesContent'); return { title: (w.renderContext().morphNode.querySelector('.window-title') || {}).textContent || '', sites: [...r.querySelectorAll('.lw-site b')].map((e) => e.textContent), empty: /No sites yet/.test(r.innerText), text: r.innerText.slice(0, 200), fits: Math.ceil(r.getBoundingClientRect().height) === Math.round(view.getExtent().y) && Math.abs(w.getExtent().y - (Math.ceil(r.getBoundingClientRect().height) + 25)) <= 1 }; });
    let sw = await until(async () => { const x = await sitesWin(); return x && x.sites.length ? x : null; }, 8000);
    check('it lists the trusted site, in a window titled "Trusted sites" that fits its content, and says what trusting means', !!sw && /Trusted sites/.test(sw.title) && JSON.stringify(sw.sites) === '["link.test"]' && sw.fits && /opens without the warning/.test(sw.text), sw);
    await frame.locator('.lw-root [data-site="link.test"]').click(); await settle();
    sw = await until(async () => { const x = await sitesWin(); return x && x.empty ? x : null; }, 8000);
    check('a real click on Remove takes the site back: the list is empty and says how to add one', !!sw && sw.sites.length === 0 && sw.fits, sw);
    check('and the warning is asked for again for that site', (await keoCall(frame, 'link.check', { url: 'https://link.test/any' })).r.skip === false);
    await frame.locator('.lw-root [data-act=close]').click(); await settle();
    check('Done closes the list', (await sitesWin()) === null);

    check('no page errors and no request left the package (other than to the local test server, in new tabs)', errors.length === 0 && outside.length === 0, [errors, outside]);
    await page.screenshot({ path: path.join(WORK, 'links.png') });
  } catch (e) {
    check('the run finished without an exception', false, String(e && e.stack || e));
  }
  await ctx.close();
  srv.close();
  console.log(failed ? 'FAILED: ' + failed : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
