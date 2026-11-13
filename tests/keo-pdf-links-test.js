// Links in a PDF (kernel: lively.data.FileUpload.buildPDFContainer in PDFUpload.js; shell ops link.*; the warning window lively.identity.LinkWarning).
// A PDF made in this test (tests/pdf-maker.js) has link areas over some of its words: an outside address with tracking parts, a link to another
// page, a link whose words name another site, a script address and a mail address. Checks, with real clicks in the real viewer and a local HTTPS
// server the browser is pointed at by a host rule: the link areas are drawn over their words (and follow a change of zoom); a link to another
// page goes there with no question; an outside link shows the warning and opens only when the person chooses, with the tracking parts left off
// when asked and no referrer; the words under a link are what the warning compares the address with; a script address is refused; a page with no
// links has none; Enter on a focused link works; outside keo's shell only the links inside the file are drawn.
// SYNTHETIC drops only. A mail link is never opened here (it would start a mail program).
// Usage: node keo-pdf-links-test.js <repo root> <extension folder> <work dir>
const fs = require('fs');
const path = require('path');
const https = require('https');
const cp = require('child_process');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const { makePdf } = require('./pdf-maker.js');
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 1200) : '')); if (!ok) failed++; }
const worldFrame = (page) => page.frames().find((f) => /world\.html$/.test(f.url()));
async function waitForWorld(page, kind) {
  let frame = null;
  for (let i = 0; i < 200; i++) {
    frame = worldFrame(page);
    if (frame) { try { if (await frame.evaluate((k) => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind === k), kind)) break; } catch (e) {} }
    frame = null; await sleep(300);
  }
  if (!frame) throw new Error('the world did not start as ' + kind);
  await sleep(2500);
  return frame;
}
async function until(fn, ms) { const end = Date.now() + (ms || 15000); let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch (e) {} await sleep(150); } return v; }
function makeCert() {
  const key = path.join(WORK, 'pdflinks-key.pem'), cert = path.join(WORK, 'pdflinks-cert.pem');
  const r = cp.spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=link.test', '-addext', 'subjectAltName=DNS:link.test', '-days', '2'], { encoding: 'utf8', env: Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1' }) });
  if (r.status !== 0) throw new Error('openssl could not make a certificate: ' + (r.stderr || r.error || '').toString().slice(0, 300));
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

// page one: five words with a link area each; page two: no links; page three: the target of the page link
const PAGES = [
  [{ x: 72, y: 700, size: 24, text: 'Links page' },
   { x: 72, y: 650, size: 18, text: 'Visit the catalogue' }, { x: 72, y: 610, size: 18, text: 'Jump to page three' }, { x: 72, y: 570, size: 18, text: 'library.example.org' },
   { x: 72, y: 530, size: 18, text: 'Run the script' }, { x: 72, y: 490, size: 18, text: 'Write to the editor' }],
  [{ x: 72, y: 700, size: 24, text: 'No links here' }],
  [{ x: 72, y: 700, size: 24, text: 'Page three' }],
];
const LINKS = [[
  { x: 70, y: 646, w: 170, h: 24, uri: 'https://link.test/pdf?id=1&utm_source=mail' },
  { x: 70, y: 606, w: 175, h: 24, page: 3 },
  { x: 70, y: 566, w: 180, h: 24, uri: 'https://promo.adnetwork.example/x' },
  { x: 70, y: 526, w: 130, h: 24, uri: 'javascript:alert(1)' },
  { x: 70, y: 486, w: 170, h: 24, uri: 'mailto:editor@example.org' },
]];
const PDF = makePdf({ pages: PAGES, links: LINKS });

const DROP = async ([b64, name, x, y]) => {
  const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const f = new File([u8], name, { type: 'application/pdf' });
  const dt = new DataTransfer(); dt.items.add(f);
  const el = document.elementFromPoint(x, y);
  const mk = (type) => new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y });
  el.dispatchEvent(mk('dragenter')); el.dispatchEvent(mk('dragover')); el.dispatchEvent(mk('drop'));
  return true;
};
const INFO = () => { const i = document.querySelector('.kpv .kpv-info'); return i ? i.textContent : null; };
const DRAWN = () => { const p = document.querySelector('.kpv .kpv-page'); return p ? p.getAttribute('data-drawn') : null; };
const LINKS_NOW = () => [...document.querySelectorAll('.kpv-links a')].map((a) => { const r = a.getBoundingClientRect(); return { title: a.title, x: r.left, y: r.top, w: r.width, h: r.height }; });
const WINDOW = () => {
  const w = $world.submorphs.filter((m) => m.name === 'LinkWarning')[0]; if (!w) return null;
  const r = document.querySelector('.lw-root'); if (!r) return null;
  return { title: (w.renderContext().morphNode.querySelector('.window-title') || {}).textContent || '', host: ((r.querySelector('.lw-host') || {}).textContent || '').trim(), finds: [...r.querySelectorAll('.lw-find b')].map((b) => b.textContent.trim()),
    buttons: [...r.querySelectorAll('.lw-btns button')].map((b) => b.textContent.trim()), src: ((r.querySelector('.lw-src') || {}).textContent || ''), head: ((r.querySelector('.lw-head') || {}).innerText || '') };
};

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const seen = [];
  const srv = https.createServer(makeCert(), (req, res) => { if (req.url !== '/favicon.ico') seen.push({ url: req.url, referer: req.headers.referer || null }); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>landed</title>'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-pdflinks-' + Date.now()), {
    headless: false, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--ignore-certificate-errors', `--host-resolver-rules=MAP link.test 127.0.0.1:${port}, MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND`] });
  await sleep(2500);
  const pageErrors = [], tabs = [];
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)));
    ctx.on('page', (p) => { if (p !== page) tabs.push(p); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    await page.goto(`chrome-extension://${ID}/start.html`);
    let frame = await waitForWorld(page, 'gate');
    await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }));
    await frame.evaluate(() => window.keo.call('world.go', { kind: 'blank' }, 120000)).catch(() => {});
    frame = await waitForWorld(page, 'blank');
    await frame.evaluate(() => new Promise((res) => lively.require('lively.identity.LinkWarning').toRun(res)));
    const L = (sel, opts) => frame.locator(sel, opts);
    const win = () => frame.evaluate(WINDOW);
    const settle = async () => { await sleep(300); await until(async () => { const a = await frame.evaluate(DRAWN); await sleep(250); return a && a === await frame.evaluate(DRAWN); }, 10000); };
    const nextTab = async (before) => { const t = await until(() => tabs.length > before, 8000); await sleep(400); if (tabs[before]) { try { await tabs[before].close(); } catch (e) {} } await page.bringToFront(); return !!t; };
    const linkAt = (i) => L('.kpv-links a').nth(i);

    await frame.evaluate(DROP, [PDF.toString('base64'), 'links.pdf', 40, 80]);
    check('the viewer opens the PDF', !!(await until(async () => (await frame.evaluate(INFO)) === 'Page 1 of 3', 30000)), await frame.evaluate(INFO));
    await settle();
    // the box is moved to the left edge and made a little wider, so the window the click opens does not cover the links
    await frame.evaluate(() => { let m = null; $world.withAllSubmorphsDo((x) => { if (x.shape && x.shape.fileHandle === 'keo:local' && x.shape.mime === 'application/pdf') m = x; }); if (m) { m.setExtent(pt(560, 640)); m.setPosition(pt(10, 60)); } });
    await settle();

    // ---- drawn over their words
    let ls = await frame.evaluate(LINKS_NOW);
    check('five link areas are drawn on page one', ls.length === 5, ls.map((l) => l.title));
    check('the outside ones carry their address as the hover text, the page link says what it does', ls[0].title === 'https://link.test/pdf?id=1&utm_source=mail' && ls[1].title === 'Go to the place this link names' && ls[3].title === 'javascript:alert(1)', ls.map((l) => l.title));
    const overlap = (zoomLabel) => frame.evaluate(() => {
      const spans = [...document.querySelectorAll('.kpv-text span')], links = [...document.querySelectorAll('.kpv-links a')];
      const byText = (t) => spans.find((s) => s.textContent.indexOf(t) === 0);
      const cover = (a, b) => { const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)), y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)); return x * y / (b.width * b.height); };
      return ['Visit the catalogue', 'Jump to page three', 'library.example.org', 'Run the script', 'Write to the editor'].map((t, i) => { const s = byText(t); return s ? Math.round(cover(links[i].getBoundingClientRect(), s.getBoundingClientRect()) * 100) : -1; });
    });
    const cov = await overlap();
    check('each link area covers the words it is for (at least 80% of the words are inside it)', cov.every((c) => c >= 80), cov);
    await L('.kpv-zoom').selectOption('200'); await sleep(600); await settle();
    const cov2 = await overlap();
    check('after zooming to 200% the link areas are redrawn over their words again', cov2.every((c) => c >= 80) && (await frame.evaluate(LINKS_NOW)).length === 5, cov2);
    await L('.kpv-zoom').selectOption('width'); await sleep(600); await settle();

    // ---- a link to another page
    const sn = seen.length, tb = tabs.length;
    await frame.evaluate(() => document.querySelectorAll('.kpv-links a')[1].scrollIntoView({ block: 'center' }));
    await linkAt(1).click();
    check('a click on the link to another page goes there, with no question and nothing opened', !!(await until(async () => (await frame.evaluate(INFO)) === 'Page 3 of 3', 8000)) && (await win()) === null && tabs.length === tb && seen.length === sn, [await frame.evaluate(INFO), await win()]);
    await settle();
    check('page three has no links', (await frame.evaluate(LINKS_NOW)).length === 0);
    await L('.kpv [data-act=prev]').click(); await L('.kpv [data-act=prev]').click(); await settle();
    check('the page with no links (page two) has none; page one has its five again after going back', (await until(async () => (await frame.evaluate(INFO)) === 'Page 1 of 3', 8000)) && (await frame.evaluate(LINKS_NOW)).length === 5);

    // ---- an outside link
    await linkAt(0).click();
    let w = await until(async () => { const x = await win(); return x && x.host === 'link.test' ? x : null; }, 8000);
    check('a click on an outside link shows the warning for its address, with the tracking part found, and says it is in a PDF', !!w && /Leaving keo/.test(w.title) && JSON.stringify(w.finds) === '["1 tracking part in the address"]' && w.src === 'Link in: a PDF', w);
    check('nothing has been opened yet', tabs.length === tb && seen.length === sn);
    const b = tabs.length;
    await frame.locator('.lw-root [data-act=open-clean]').click();
    const opened = await nextTab(b);
    const hit = await until(() => seen.find((s) => s.url.indexOf('/pdf') === 0));
    check('Open cleaned link opens the page without the tracking part, and sends no referrer', opened && !!hit && hit.url === '/pdf?id=1' && hit.referer === null, [opened, hit]);

    // ---- the words under the link
    await linkAt(2).click();
    w = await until(async () => { const x = await win(); return x && /adnetwork/.test(x.host) ? x : null; }, 8000);
    check('the words under a link are compared with where it goes ("library.example.org" over an address for another site)', !!w && w.finds.some((f) => /names a different site/.test(f)), w);
    await page.keyboard.press('Escape'); await sleep(600);
    check('Esc closes the warning', (await win()) === null);

    // ---- a script address
    await linkAt(3).click();
    w = await until(async () => { const x = await win(); return x && /Link blocked/.test(x.title) ? x : null; }, 8000);
    check('a script address in a PDF gives a window that says keo will not open it, with only Close', !!w && JSON.stringify(w.buttons) === '["Close"]' && /will not open this link/.test(w.head), w);
    await frame.locator('.lw-root [data-act=cancel]').click(); await sleep(600);

    // ---- a mail address (shown, not opened)
    await linkAt(4).click();
    w = await until(async () => { const x = await win(); return x && /email/i.test(x.title) ? x : null; }, 8000);
    check('a mail link shows the email window (it is not opened here)', !!w && /starts an email/.test(w.head) && w.host === 'editor@example.org', w);
    await page.keyboard.press('Escape'); await sleep(600);

    // ---- the keyboard
    await linkAt(1).focus(); await page.keyboard.press('Enter');
    check('Enter on a focused link works like a click (the page link goes to page three)', !!(await until(async () => (await frame.evaluate(INFO)) === 'Page 3 of 3', 8000)), await frame.evaluate(INFO));
    await L('.kpv [data-act=prev]').click(); await L('.kpv [data-act=prev]').click(); await settle();

    // ---- outside keo's shell only the links inside the file are drawn
    const bare = await frame.evaluate(async ([b64]) => {
      await new Promise((res) => lively.require('lively.data.PDFUpload').toRun(res));
      const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const saved = window.keo; window.keo = undefined;
      let box; try { box = lively.data.FileUpload.buildPDFContainer(u8); } finally { window.keo = saved; }
      box.style.cssText += ';position:fixed;left:700px;top:80px;width:520px;height:600px;z-index:50;background:#fff';
      document.body.appendChild(box);
      for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 250)); if (box.querySelector('.kpv-page[data-drawn]')) break; }
      await new Promise((r) => setTimeout(r, 600));
      const out = [...box.querySelectorAll('.kpv-links a')].map((a) => a.title);
      box.remove();
      return out;
    }, [PDF.toString('base64')]);
    check('without the shell: only the link to another page is drawn, no outside address', bare.length === 1 && bare[0] === 'Go to the place this link names', bare);

    check('no page errors', pageErrors.length === 0, pageErrors);
    await page.screenshot({ path: path.join(WORK, 'pdf-links.png') });
  } catch (e) {
    check('the run finished without an exception', false, String(e && e.stack || e));
  }
  await ctx.close();
  srv.close();
  console.log(failed ? 'FAILED: ' + failed : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
