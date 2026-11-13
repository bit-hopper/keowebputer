// Links between the parts of a book (kernel: lively.data.DocumentUpload, the book viewer). The page of a part is shown in a frame that
// lets nothing run and nothing out, so it cannot follow a link itself: the viewer lists the links of the part in its own toolbar and does
// the going. Checks (the real viewer, a book built in the page, the list used by real selections): the list holds only links to other parts
// of the book (not a web address, not a place in the same part, not a file that is not in the book, not a duplicate); choosing one opens
// that part; a link to a place in a part opens it scrolled to that place (an address made in the page, with the place after it), a link
// without a place opens the top; a part with no such links shows no list; a bad place in a link opens the top and breaks nothing; the
// frame is as closed as before (no sandbox allowance, no script, the page's own links to other parts are not live); Prev and Next, and
// the text size, still work after going to a place.
// Usage: node keo-epub-links-test.js <repo root> <extension folder> <work dir>
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 900) : '')); if (!ok) failed++; }
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
async function until(fn, ms) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > (ms || 15000)) return v; await sleep(250); } }

// The book: three parts. Part one links to a place in part two, to part three, to itself by file name, to the web, to a file that is not
// in the book, twice to the same place (one is a duplicate) and to a place with a bad name. Part two is long, with a place far down.
const BUILD = async () => {
  await new Promise((res) => lively.require('lively.data.DocumentUpload').toRun(res));
  const enc = new TextEncoder();
  const crcT = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = crcT[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const makeZip = async (entries) => {
    const parts = [], central = []; let off = 0;
    for (const e of entries) {
      const name = enc.encode(e.name), data = enc.encode(e.text), crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), name);
      off += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((a, p) => a + p.length, 0);
    const eo = new DataView(new ArrayBuffer(22)); eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, entries.length, true); eo.setUint16(10, entries.length, true); eo.setUint32(12, cdSize, true); eo.setUint32(16, off, true);
    return new Uint8Array(await new Blob([...parts, ...central, new Uint8Array(eo.buffer)]).arrayBuffer());
  };
  const X = (body) => '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>' + body + '</body></html>';
  const CH1 = X('<h1>Chapter one</h1><p>Go to <a href="ch2.xhtml#deep">the deep section</a>, or <a href="ch3.xhtml">the last chapter</a>, or back to <a href="ch1.xhtml#top1">the top of this one</a>. A <a href="http://example.com/x">web link</a>, a <a href="missing.xhtml">file not in the book</a>, a <a href="#local">place in this part</a>, the <a href="ch2.xhtml#deep">same deep section</a> again, and a <a href="ch2.xhtml#bad%20place">bad place</a>.</p><h2 id="top1">Top of one</h2><p id="local">Local place.</p>');
  const CH2 = X('<h1>Chapter two</h1><p>An <a href="http://example.com/in-two">outside link in two</a>.</p>' + Array.from({ length: 140 }, (_, i) => '<p>Line ' + (i + 1) + ' of the long text.</p>').join('') + '<h2 id="deep">The deep section</h2><p>Deep words.</p>' + Array.from({ length: 140 }, (_, i) => '<p>More line ' + (i + 1) + '.</p>').join('') + '');
  const CH3 = X('<h1>Chapter three</h1><p>The last words, with no links at all.</p>');
  const OPF = '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Linked</dc:title></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/><item id="c3" href="ch3.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>';
  const bytes = await makeZip([
    { name: 'mimetype', text: 'application/epub+zip' },
    { name: 'META-INF/container.xml', text: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
    { name: 'OEBPS/content.opf', text: OPF }, { name: 'OEBPS/ch1.xhtml', text: CH1 }, { name: 'OEBPS/ch2.xhtml', text: CH2 }, { name: 'OEBPS/ch3.xhtml', text: CH3 }]);
  const box = lively.data.FileUpload.buildDocumentContainer(bytes, { type: 'application/epub+zip', name: 'linked.epub' });
  box.id = '__book';
  box.style.cssText += ';position:fixed;left:20px;top:80px;width:620px;height:420px;z-index:99999;background:#fff;border:1px solid #888';
  document.body.appendChild(box);
  return true;
};
// what the viewer shows: the labels in its toolbar and the state of the list
const TOOLBAR = () => {
  const box = document.getElementById('__book'); if (!box) return null;
  const sels = [...box.querySelectorAll('select')];
  const chapters = sels[0], links = sels[1], f = box.querySelector('iframe');
  return { chapter: chapters && chapters.options[chapters.selectedIndex] ? chapters.options[chapters.selectedIndex].textContent : null,
    linksShown: !!links && links.style.display !== 'none', links: links ? [...links.options].map((o) => o.textContent) : [],
    sandbox: f ? f.getAttribute('sandbox') : null, src: f ? (f.getAttribute('src') || '').slice(0, 12) : null, hasSrcdoc: f ? f.hasAttribute('srcdoc') : null,
    prevDisabled: [...box.querySelectorAll('button')].find((b) => /Prev/.test(b.textContent)).disabled, nextDisabled: [...box.querySelectorAll('button')].find((b) => /Next/.test(b.textContent)).disabled };
};
// what the page in the frame shows and how far it has scrolled (the frame lets no script run, but the debugging protocol can read it)
const PAGE = () => ({ title: ((document.querySelector('h1') || {}).textContent || ''), scroll: Math.round(window.scrollY), deepTop: document.getElementById('deep') ? Math.round(document.getElementById('deep').getBoundingClientRect().top) : null,
  liveLinks: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')), csp: (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || null, scripts: document.querySelectorAll('script').length, fontPct: (getComputedStyle(document.body).fontSize) });

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-epublinks-' + Date.now()), {
    headless: false, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  try {
    const page = await ctx.newPage();
    const errors = [], outside = [];
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    page.on('request', (rq) => { const u = rq.url(); if (!/^(chrome-extension|blob|data|about):/.test(u) && !/youtube\.com\/iframe_api$/.test(u)) outside.push(u.slice(0, 100)); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    await page.goto(`chrome-extension://${ID}/start.html`);
    let frame = await waitForWorld(page, 'gate');
    await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }));
    await keoCall(frame, 'world.go', { kind: 'enter' }).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    await keoCall(frame, 'world.go', { kind: 'blank', name: 'Book room' }).catch(() => {});
    frame = await waitForWorld(page, 'blank', 'Book room');
    await frame.evaluate(BUILD);
    const inner = () => frame.childFrames().find((f) => f.url() === 'about:srcdoc' || /^blob:/.test(f.url()));
    const readPage = async (wanted) => { const v = await until(async () => { const f = inner(); if (!f) return null; try { const p = await f.evaluate(PAGE); return wanted(p) ? p : null; } catch (e) { return null; } }, 15000); return v; };
    const pick = (i) => frame.locator('#__book select').nth(1).selectOption({ index: i });

    // ---- part one and its list
    let p1 = await readPage((p) => /Chapter one/.test(p.title));
    let tb = await frame.evaluate(TOOLBAR);
    check('the book opens at part one', !!p1 && tb.chapter === 'Part 1' && tb.prevDisabled && !tb.nextDisabled, [p1 && p1.title, tb]);
    check('the list shows only the three links to other parts (the deep section, the last chapter, the top of this part by file name) and the bad-place link, one entry for each place; the web link, the missing file, the plain place, and the second link to the same place are not in it', tb.linksShown && tb.links.join('|') === 'Links (4)|the deep section › Part 2|the last chapter › Part 3|the top of this one › Part 1|bad place › Part 2', tb.links);
    check('the frame lets one script run, the viewer\'s own, and nothing else: sandbox "allow-scripts" only, a policy that names that script\'s nonce and allows nothing else, one script in the page, and no link to another part is live', !!p1 && tb.sandbox === 'allow-scripts' && /default-src 'none'/.test(p1.csp || '') && /script-src 'nonce-[0-9a-f]{32}'$/.test(p1.csp || '') && p1.scripts === 1 && p1.liveLinks.every((h) => h.charAt(0) === '#'), [tb.sandbox, p1 && p1.csp, p1 && p1.scripts, p1 && p1.liveLinks]);
    check('part one is shown from a page given as text (no address)', tb.hasSrcdoc === true && !tb.src, tb);

    // ---- a link to a place in another part
    await pick(1);
    let p2 = await readPage((p) => /Chapter two/.test(p.title) && p.scroll > 1000);
    tb = await frame.evaluate(TOOLBAR);
    check('choosing "the deep section" opens part two scrolled to that place (the place is at the top of the frame)', !!p2 && p2.scroll > 2000 && p2.deepTop !== null && Math.abs(p2.deepTop) <= 2, p2);
    check('the part list follows (Part 2), Prev and Next both work now, and this part has no links so the list is gone', tb.chapter === 'Part 2' && !tb.prevDisabled && !tb.nextDisabled && !tb.linksShown, tb);
    // asked of the page itself (the test tool's own record of a frame's address can lag behind a move from a text page to an address)
    const where = await inner().evaluate(() => location.href).catch((e) => 'ERR ' + e.message.slice(0, 80));
    check('the frame is still closed after going to a place (the page now comes from an address made in the page, with the place after it)', /^blob:null\/[0-9a-f-]+#deep$/.test(where) && tb.sandbox === 'allow-scripts' && tb.hasSrcdoc === false, [where, tb]);
    // a click on a link that leaves the book works in this mode too (the page comes from an address made in the page, and carries the same script)
    await inner().locator('a', { hasText: 'outside link in two' }).click({ timeout: 8000 });
    const warned = await until(() => frame.evaluate(() => { const w = $world.submorphs.filter((m) => m.name === 'LinkWarning')[0]; return w ? (document.querySelector('.lw-host') || {}).textContent : null; }), 10000);
    check('a click on a link that leaves the book, from a part opened at a place, shows the warning for that address', warned === 'example.com', warned);
    await frame.evaluate(() => { const w = $world.submorphs.filter((m) => m.name === 'LinkWarning')[0]; if (w) w.remove(); });

    // ---- Prev, Next and the text size after going to a place
    await frame.locator('#__book button', { hasText: 'Next' }).click();
    let p3 = await readPage((p) => /Chapter three/.test(p.title));
    tb = await frame.evaluate(TOOLBAR);
    check('Next from there opens part three at its top, from a page given as text again', !!p3 && p3.scroll === 0 && tb.chapter === 'Part 3' && tb.nextDisabled && tb.hasSrcdoc === true, [p3, tb]);
    await frame.locator('#__book button', { hasText: 'A+' }).click();
    const bigger = await readPage((p) => parseFloat(p.fontPct) > 16.5);
    check('the text size button still works', !!bigger, bigger && bigger.fontPct);

    // ---- a link without a place, and the same by a link from part one again
    await frame.locator('#__book select').first().selectOption({ index: 0 });
    p1 = await readPage((p) => /Chapter one/.test(p.title));
    await pick(2);
    p3 = await readPage((p) => /Chapter three/.test(p.title));
    tb = await frame.evaluate(TOOLBAR);
    check('a link with no place ("the last chapter") opens part three at its top', !!p3 && p3.scroll === 0 && tb.chapter === 'Part 3', [p3 && p3.scroll, tb.chapter]);

    // ---- a link to a place in the same part, written with the file's name
    await frame.locator('#__book select').first().selectOption({ index: 0 });
    await readPage((p) => /Chapter one/.test(p.title));
    await pick(3);
    const own = await readPage((p) => /Chapter one/.test(p.title));
    tb = await frame.evaluate(TOOLBAR);
    check('a link to a place in the same part (by file name) stays in part one and lists its links again', !!own && tb.chapter === 'Part 1' && tb.linksShown, [own && own.title, tb.chapter]);

    // ---- a bad place
    await pick(4);
    const bad = await readPage((p) => /Chapter two/.test(p.title));
    tb = await frame.evaluate(TOOLBAR);
    check('a link whose place has a bad name opens part two at its top, with nothing broken', !!bad && bad.scroll === 0 && tb.chapter === 'Part 2' && tb.hasSrcdoc === true, [bad, tb]);

    check('no request left the package', outside.length === 0, outside);
    check('no page errors', errors.length === 0, errors);
    await page.screenshot({ path: path.join(WORK, 'epub-links.png') });
  } catch (e) {
    check('the run finished without an exception', false, String(e && e.stack || e));
  }
  await ctx.close();
  console.log(failed ? 'FAILED: ' + failed : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
