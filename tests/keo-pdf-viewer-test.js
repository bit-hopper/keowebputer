// The PDF viewer (kernel: lively.data.FileUpload.buildPDFContainer in PDFUpload.js, EncryptedPDF in EncryptedMedia.js; shell:
// library.noteGet / library.notePut in keo-library.js). A PDF built here (tests/pdf-maker.js) with known words, an outline and a named
// destination is dropped on the world and driven by REAL clicks, typing and mouse drags through the page's own buttons: pages,
// zoom, the outline, the small pictures of the pages, find, a highlight with a note, and what is kept beside the file (what the shell
// accepts and refuses, that it moves with "Move my data" and goes with the file).
// Judged from the page's own DOM and pixels (the canvas, the transparent text laid over it, the rectangles drawn), not from a picture.
// Not covered here: a password-protected PDF (no writer for encrypted files), a real authenticator, a PDF with many hundreds of pages.
// Usage: node keo-pdf-viewer-test.js <repo root> <package folder> <work dir>
const fs = require('fs');
const path = require('path');
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
const keoCall = (frame, op, args) => frame.evaluate(([o, a]) => window.keo.call(o, a, 60000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [op, args || {}]);
async function until(fn, ms) { const end = Date.now() + (ms || 15000); let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch (e) {} await sleep(150); } return v; }

// The document: four pages. "fox" is in the words of pages 1 (twice), 2 (as "Fox", capital) and 4 (once).
const PAGES = [
  [{ x: 72, y: 700, size: 28, text: 'Chapter One' }, { x: 72, y: 650, size: 18, text: 'The quick brown fox jumps over the lazy dog.' }, { x: 72, y: 620, size: 18, text: 'The second line has the word fox again.' }, { x: 72, y: 560, size: 18, text: 'Highlight target words here.' }],
  [{ x: 72, y: 700, size: 28, text: 'Chapter Two' }, { x: 72, y: 650, size: 18, text: 'Fox hunting is not what this page is about.' }],
  [{ x: 72, y: 700, size: 28, text: 'Part Three' }, { x: 72, y: 650, size: 18, text: 'Nothing about animals on this page.' }],
  [{ x: 72, y: 700, size: 28, text: 'Chapter Four' }, { x: 72, y: 650, size: 18, text: 'The last fox leaves (and the end) here.' }],
];
const OUTLINE = [
  { title: 'Part A', page: 1, children: [{ title: 'Chapter One', page: 1 }, { title: 'Chapter Two', page: 2 }] },
  { title: 'Part B', name: 'partb', children: [{ title: 'Chapter Four', page: 4 }] },
];
const STORY = makePdf({ pages: PAGES, outline: OUTLINE, named: { partb: 3 } });
const PLAIN = makePdf({ pages: [[{ x: 72, y: 700, size: 20, text: 'A page with no outline' }]] });
const BAD = Buffer.from('this is not a PDF, only words');

// ---- in the page ----
const DROP = async ([b64, name, x, y]) => {
  const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const f = new File([u8], name, { type: 'application/pdf' });
  const b64u = (a) => { let s = ''; for (const b of a) s += String.fromCharCode(b); return btoa(s).split('+').join('-').split('/').join('_').split('=').join(''); };
  const id = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', u8)));
  const dt = new DataTransfer(); dt.items.add(f);
  const el = document.elementFromPoint(x, y);
  const mk = (type) => new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y });
  el.dispatchEvent(mk('dragenter')); el.dispatchEvent(mk('dragover')); el.dispatchEvent(mk('drop'));
  return { id, size: u8.length };
};
const REMOVE = (id) => { let m = null; $world.withAllSubmorphsDo((x) => { if (x.shape && x.shape.fileObjId === id) m = x; }); if (m) m.remove(); return !!m; };
const RESIZE = ([id, w, h]) => { let m = null; $world.withAllSubmorphsDo((x) => { if (x.shape && x.shape.fileObjId === id) m = x; }); m.setExtent(pt(w, h)); };
const INFO = () => { const i = document.querySelector('.kpv .kpv-info'); return i ? i.textContent : null; };
const DRAWN = () => { const p = document.querySelector('.kpv .kpv-page'); return p ? p.getAttribute('data-drawn') : null; };

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-pdf-' + Date.now()), {
    headless: false, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  const pageErrors = [], outside = [];
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)));
    page.on('request', (rq) => { const u = rq.url(); if (/^(chrome-extension|blob|data|about):/.test(u) || /youtube\.com\/iframe_api$/.test(u)) return; outside.push(rq.method() + ' ' + u.slice(0, 100)); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });

    await page.goto(`chrome-extension://${ID}/start.html`);
    let frame = await waitForWorld(page, 'gate');
    await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }));
    await frame.evaluate(() => window.keo.call('world.go', { kind: 'blank' }, 120000)).catch(() => {});
    frame = await waitForWorld(page, 'blank');
    const L = (sel, opts) => frame.locator(sel, opts);
    const text = (sel) => frame.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
    const infoText = () => frame.evaluate(INFO);
    const waitInfo = (want, ms) => until(async () => (await infoText()) === want, ms || 15000);
    const settle = async () => { await sleep(300); await until(async () => { const a = await frame.evaluate(DRAWN); await sleep(250); return a && a === await frame.evaluate(DRAWN); }, 10000); };
    const drop = async (buf, name) => { const r = await frame.evaluate(DROP, [buf.toString('base64'), name, 40, 80]); await sleep(1500); return r; };

    // ---- opening ----
    const story = await drop(STORY, 'story.pdf');
    check('the viewer opens the dropped PDF and says "Page 1 of 4"', !!(await waitInfo('Page 1 of 4', 30000)), await infoText());
    await settle();
    const first = await frame.evaluate(() => {
      const cv = document.querySelector('.kpv-page canvas'), t = document.querySelector('.kpv-text');
      const g = cv.getContext('2d'), d = g.getImageData(0, 0, cv.width, cv.height).data;
      let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100) dark++;
      return { dark, w: cv.width, h: cv.height, ratio: cv.width / cv.height, spans: t.querySelectorAll('span').length, text: t.textContent, prevOff: document.querySelector('[data-act=prev]').disabled, nextOff: document.querySelector('[data-act=next]').disabled };
    });
    check('page one is drawn on the canvas (a letter-size page with dark text on white)', first.dark > 500 && Math.abs(first.ratio - 612 / 792) < 0.01, first);
    check('the words of page one are laid over it as text (4 pieces) and nothing of page two', first.spans === 4 && /Chapter One/.test(first.text) && /Highlight target words here\./.test(first.text) && !/Chapter Two/.test(first.text), first);
    check('Previous is off on the first page and Next is on', first.prevOff === true && first.nextOff === false, first);

    // the transparent text sits exactly over the printed words: ink inside a piece's box, none a line and a half lower
    const align = await frame.evaluate(() => {
      const cv = document.querySelector('.kpv-page canvas'), cr = cv.getBoundingClientRect(), g = cv.getContext('2d'), sx = cv.width / cr.width, sy = cv.height / cr.height;
      const ink = (r) => { const x = Math.max(0, Math.floor((r.left - cr.left) * sx)), y = Math.max(0, Math.floor((r.top - cr.top) * sy)), w = Math.max(1, Math.floor(r.width * sx)), h = Math.max(1, Math.floor(r.height * sy));
        const d = g.getImageData(x, y, Math.min(w, cv.width - x), Math.min(h, cv.height - y)).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 120) n++; return n; };
      return Array.from(document.querySelectorAll('.kpv-text span')).map((s) => { const r = s.getBoundingClientRect(), h = r.height, wide = { left: r.left, top: r.top - 0.4 * h, width: r.width, height: 1.8 * h };
        const inside = ink(r), all = ink(wide); return { t: s.textContent.slice(0, 14), inside, outside: all - inside, area: Math.round(r.width * r.height) }; });
    });
    check('each piece of text lies over its printed words (nearly all the ink of its line is inside its box, little just above or below it)', align.length === 4 && align.every((a) => a.inside > 0.03 * a.area && a.outside < 0.15 * a.inside), align);

    // ---- pages, by real clicks ----
    await L('.kpv [data-act=next]').click();
    check('a real click on Next shows "Page 2 of 4" with the words of page two', !!(await waitInfo('Page 2 of 4')) && (await settle(), /Chapter Two/.test(await text('.kpv-text'))), await infoText());
    await L('.kpv [data-act=next]').click(); await waitInfo('Page 3 of 4');
    await L('.kpv [data-act=next]').click(); await waitInfo('Page 4 of 4'); await settle();
    check('on the last page Next is off, Previous is on', await frame.evaluate(() => document.querySelector('[data-act=next]').disabled && !document.querySelector('[data-act=prev]').disabled));
    await L('.kpv [data-act=prev]').click();
    check('a real click on Previous goes back to page three', !!(await waitInfo('Page 3 of 4')));
    await L('.kpv [data-act=prev]').click(); await waitInfo('Page 2 of 4'); await L('.kpv [data-act=prev]').click(); await waitInfo('Page 1 of 4'); await settle();

    // ---- zoom ----
    const geom = () => frame.evaluate(() => { const p = document.querySelector('.kpv-page'), v = document.querySelector('.kpv-view'), s = document.querySelector('.kpv-zoom'); return { w: Math.round(p.getBoundingClientRect().width), h: Math.round(p.getBoundingClientRect().height), viewW: v.clientWidth, viewH: v.clientHeight, scrollW: v.scrollWidth, zoom: s.value, drawn: p.getAttribute('data-drawn') }; });
    let g = await geom();
    check('Fit width: the page fills the width of the box (less the margins)', Math.abs(g.w - (g.viewW - 16)) <= 2 && g.zoom === 'width', g);
    await L('.kpv [data-act=zoomin]').click(); await settle(); g = await geom();
    check('Zoom in steps to the next size above the fitted one (75%: 612 pixels wide)', g.zoom === '75' && Math.abs(g.w - 612) <= 2, g);
    await L('.kpv [data-act=zoomout]').click(); await settle(); g = await geom();
    check('Zoom out steps to 50% (408 pixels wide)', g.zoom === '50' && Math.abs(g.w - 408) <= 2, g);
    await L('.kpv [data-act=zoom]').selectOption('100'); await settle(); g = await geom();
    check('choosing 100% makes the page 816 pixels wide (96 pixels to the inch) and the box scrolls sideways', Math.abs(g.w - 816) <= 2 && g.scrollW > g.viewW, g);
    await L('.kpv [data-act=zoom]').selectOption('page'); await settle(); g = await geom();
    check('Fit page: the whole page is in view', g.zoom === 'page' && g.h <= g.viewH - 16 + 1 && g.w <= g.viewW - 16 + 1, g);
    await L('.kpv [data-act=zoom]').selectOption('width'); await settle();
    await frame.evaluate(RESIZE, [story.id, 480, 700]);
    await sleep(800); await settle(); g = await geom();
    check('when the box is made narrower the fitted page follows it', Math.abs(g.w - (g.viewW - 16)) <= 2 && g.viewW < 480, g);
    await frame.evaluate(RESIZE, [story.id, 600, 800]);
    await sleep(800); await settle();

    // ---- side panel: outline ----
    const sideOpen = () => frame.evaluate(() => /open/.test(document.querySelector('.kpv-side').className));
    check('the side panel starts closed', (await sideOpen()) === false);
    await L('.kpv [data-act=side]').click();
    check('a real click on the menu button opens it', (await sideOpen()) === true);
    const rows = () => frame.evaluate(() => Array.from(document.querySelectorAll('.kpv-pane[data-pane=outline] .kpv-row')).map((r) => r.textContent.replace(/^(expand_more|chevron_right)/, '')));
    await until(async () => (await rows()).length === 5);
    check('the outline lists the entries of the document, nested', JSON.stringify(await rows()) === JSON.stringify(['Part A', 'Chapter One', 'Chapter Two', 'Part B', 'Chapter Four']), await rows());
    await L('.kpv-pane[data-pane=outline] .kpv-row', { hasText: 'Chapter Two' }).first().click();
    check('a click on an outline entry goes to its page (Chapter Two: page 2)', !!(await waitInfo('Page 2 of 4')), await infoText());
    await L('.kpv-pane[data-pane=outline] .kpv-row', { hasText: 'Part B' }).first().click();
    check('an entry that points by NAME is found too (Part B: page 3)', !!(await waitInfo('Page 3 of 4')), await infoText());
    await L('.kpv-pane[data-pane=outline] .kpv-row', { hasText: 'Chapter Four' }).first().click();
    check('a nested entry works (Chapter Four: page 4)', !!(await waitInfo('Page 4 of 4')), await infoText());
    await page.screenshot({ path: path.join(WORK, 'pdf-outline.png') });
    await L('.kpv-pane[data-pane=outline] .kpv-row').first().locator('.kpv-tw').click();
    check('the little arrow of an entry hides what is under it', await frame.evaluate(() => getComputedStyle(document.querySelector('.kpv-pane[data-pane=outline] .kpv-row + div')).display) === 'none');
    await L('.kpv-pane[data-pane=outline] .kpv-row').first().locator('.kpv-tw').click();
    check('...and shows it again', await frame.evaluate(() => getComputedStyle(document.querySelector('.kpv-pane[data-pane=outline] .kpv-row + div')).display) === 'block');

    // ---- side panel: small pictures of the pages ----
    await L('.kpv-tab[data-tab=pages]').click();
    await until(async () => (await frame.evaluate(() => document.querySelectorAll('.kpv-thumb canvas').length)) === 4, 15000);
    const th = await frame.evaluate(() => ({ n: document.querySelectorAll('.kpv-thumb').length, canv: document.querySelectorAll('.kpv-thumb canvas').length, w: document.querySelector('.kpv-thumb canvas') && document.querySelector('.kpv-thumb canvas').width, cur: Array.from(document.querySelectorAll('.kpv-thumb')).findIndex((t) => /cur/.test(t.className)) + 1 }));
    check('the Pages list has a small picture for each of the four pages, the page on show marked', th.n === 4 && th.canv === 4 && th.w === 120 && th.cur === 4, th);
    await page.screenshot({ path: path.join(WORK, 'pdf-pages.png') });
    await L('.kpv-thumb[data-page="1"]').click();
    check('a click on a small picture goes to that page and marks it', !!(await waitInfo('Page 1 of 4')) && await frame.evaluate(() => /cur/.test(document.querySelector('.kpv-thumb[data-page="1"]').className)));
    await L('.kpv [data-act=side]').click(); await settle();
    check('the menu button closes the panel again', (await sideOpen()) === false);

    // ---- find ----
    await L('.kpv [data-act=find]').click();
    await L('.kpv-find input').click();
    await page.keyboard.type('fox');
    check('typing in the find box finds the word in the whole document: "1 of 4"', !!(await until(async () => (await text('.kpv-count')) === '1 of 4')), await text('.kpv-count'));
    await settle();
    await page.screenshot({ path: path.join(WORK, 'pdf-find.png') });
    const hitsOn = () => frame.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('.kpv-text span'));
      return Array.from(document.querySelectorAll('.kpv-hits div')).map((d) => { const r = d.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const s = spans.find((e) => { const q = e.getBoundingClientRect(); return cx >= q.left && cx <= q.right && cy >= q.top && cy <= q.bottom; });
        return { cur: d.className === 'cur', over: s ? s.textContent : null, w: Math.round(r.width) }; });
    });
    let hh = await hitsOn();
    check('both hits on page one are marked, each over a line that has the word, the first as the current one', hh.length === 2 && hh[0].cur && !hh[1].cur && hh.every((h) => /fox/.test(h.over || '') && h.w > 10 && h.w < 80), hh);
    await L('.kpv [data-act=hitnext]').click();
    check('Next match moves the current mark to the second hit: "2 of 4"', (await text('.kpv-count')) === '2 of 4' && (hh = await hitsOn()).length === 2 && !hh[0].cur && hh[1].cur, hh);
    await L('.kpv [data-act=hitnext]').click();
    check('the third hit is on page two: the page turns to it ("Fox" with a capital is found when case is ignored)', !!(await waitInfo('Page 2 of 4')) && (await text('.kpv-count')) === '3 of 4', [await infoText(), await text('.kpv-count')]);
    await settle(); hh = await hitsOn();
    check('...and it is marked there, over the right words', hh.length === 1 && hh[0].cur && /Fox hunting/.test(hh[0].over || ''), hh);
    await L('.kpv [data-act=hitnext]').click(); await waitInfo('Page 4 of 4');
    await L('.kpv [data-act=hitnext]').click(); await waitInfo('Page 1 of 4');
    check('after the last hit Next match goes round to the first ("1 of 4", page one)', (await text('.kpv-count')) === '1 of 4', await text('.kpv-count'));
    await L('.kpv [data-act=hitprev]').click(); await waitInfo('Page 4 of 4');
    check('Previous match from the first goes to the last ("4 of 4", page four)', (await text('.kpv-count')) === '4 of 4', await text('.kpv-count'));
    await L('.kpv [data-act=case]').click();
    check('Match case leaves the three hits written with a small f: "1 of 3"', !!(await until(async () => (await text('.kpv-count')) === '1 of 3')), await text('.kpv-count'));
    await L('.kpv-find input').click(); await page.keyboard.press('Enter');
    check('Enter in the box goes to the next match ("2 of 3")', !!(await until(async () => (await text('.kpv-count')) === '2 of 3')), await text('.kpv-count'));
    await page.keyboard.press('Shift+Enter');
    check('Shift+Enter goes back ("1 of 3")', !!(await until(async () => (await text('.kpv-count')) === '1 of 3')), await text('.kpv-count'));
    await L('.kpv [data-act=case]').click();
    await L('.kpv-find input').fill('brown fox');
    check('a phrase of two words is found ("1 of 1")', !!(await until(async () => (await text('.kpv-count')) === '1 of 1')), await text('.kpv-count'));
    await L('.kpv-find input').fill('(and');
    check('a bracket is looked for as a bracket ("1 of 1", on page four)', !!(await until(async () => (await text('.kpv-count')) === '1 of 1')) && !!(await waitInfo('Page 4 of 4')), [await text('.kpv-count'), await infoText()]);
    await L('.kpv-find input').fill('zzzz');
    check('a word that is not there says "No results" and marks nothing', !!(await until(async () => (await text('.kpv-count')) === 'No results')) && (await frame.evaluate(() => document.querySelectorAll('.kpv-hits div').length)) === 0, await text('.kpv-count'));
    await L('.kpv-find input').fill('fox'); await until(async () => (await text('.kpv-count')) === '1 of 4');
    await page.keyboard.press('Escape');
    const closed = await frame.evaluate(() => ({ open: /open/.test(document.querySelector('.kpv-find').className), val: document.querySelector('.kpv-find input').value, marks: document.querySelectorAll('.kpv-hits div').length }));
    check('Escape closes the find bar, clears the box and the marks', closed.open === false && closed.val === '' && closed.marks === 0, closed);
    await L('.kpv [data-act=zoom]').selectOption('width');
    for (let i = 0; i < 4 && (await infoText()) !== 'Page 1 of 4'; i++) { await L('.kpv [data-act=prev]').click(); await sleep(400); }
    await waitInfo('Page 1 of 4'); await settle();

    // ---- a highlight with a note ----
    const notesOf = async (id) => (await keoCall(frame, 'library.noteGet', { id })).r;
    check('nothing is kept beside the file before anything is highlighted', (await keoCall(frame, 'library.noteGet', { id: story.id })).r === null);
    check('the highlighter button is off until some text is selected', await frame.evaluate(() => document.querySelector('[data-act=highlight]').disabled));
    const target = L('.kpv-text span', { hasText: 'Highlight target' });
    const boxBefore = await frame.evaluate((id) => { let m = null; $world.withAllSubmorphsDo((x) => { if (x.shape && x.shape.fileObjId === id) m = x; }); return [m.getPosition().x, m.getPosition().y]; }, story.id);
    const tb = await target.boundingBox();
    await page.mouse.move(tb.x + 3, tb.y + tb.height / 2); await page.mouse.down(); await page.mouse.move(tb.x + tb.width - 3, tb.y + tb.height / 2, { steps: 8 }); await page.mouse.up();
    check('a real mouse drag over the text selects it and turns the highlighter button on', !!(await until(async () => !(await frame.evaluate(() => document.querySelector('[data-act=highlight]').disabled)))), await frame.evaluate(() => String(window.getSelection())));
    const boxAfter = await frame.evaluate((id) => { let m = null; $world.withAllSubmorphsDo((x) => { if (x.shape && x.shape.fileObjId === id) m = x; }); return [m.getPosition().x, m.getPosition().y]; }, story.id);
    check('the drag over the text did not move the box', boxBefore[0] === boxAfter[0] && boxBefore[1] === boxAfter[1], [boxBefore, boxAfter]);
    await L('.kpv [data-act=highlight]').click();
    const pop = await until(async () => frame.evaluate(() => !!document.querySelector('.kpv-pop textarea')));
    check('pressing it marks the text and opens the note box', !!pop && (await frame.evaluate(() => document.querySelectorAll('.kpv-hl div').length)) >= 1);
    const hl = await frame.evaluate(() => { const span = Array.from(document.querySelectorAll('.kpv-text span')).find((s) => /Highlight target/.test(s.textContent)).getBoundingClientRect();
      return Array.from(document.querySelectorAll('.kpv-hl div')).map((d) => { const r = d.getBoundingClientRect(); return { inside: r.left >= span.left - 4 && r.right <= span.right + 4 && r.top >= span.top - 6 && r.bottom <= span.bottom + 6, w: Math.round(r.width), h: Math.round(r.height), bg: getComputedStyle(d).backgroundColor }; }); });
    check('the yellow mark lies over the selected words and nowhere else', hl.length === 1 && hl[0].inside && hl[0].w > 100 && /255, 213, 0/.test(hl[0].bg), hl);
    await page.screenshot({ path: path.join(WORK, 'pdf-note.png') });
    await page.keyboard.type('check the second claim');
    await L('.kpv-pop .go').click();
    check('"Done" closes the note box', (await frame.evaluate(() => !document.querySelector('.kpv-pop'))) === true);
    await until(async () => { const n = await notesOf(story.id); return n && n.highlights.length === 1 && n.highlights[0].note; }, 8000);
    const n1 = await notesOf(story.id);
    check('what was marked is kept beside the file: page, text, note, where, and nothing removed', n1 && n1.highlights.length === 1 && n1.highlights[0].page === 1 && n1.highlights[0].note === 'check the second claim' && /^[a-z ]+$/i.test(n1.highlights[0].text) && 'Highlight target words here.'.includes(n1.highlights[0].text.trim()) && n1.highlights[0].rects.length === 1 && n1.highlights[0].rects[0].every((v) => v >= 0 && v <= 1) && n1.removed.length === 0, n1);
    check('the status line does not say the save failed', !/could not/.test((await text('.kpv-status')) || ''), await text('.kpv-status'));
    const exported = async () => page.evaluate(async () => (await window.keoLibrary.exportSealed()).docs.length);
    const docsWith = await exported();

    // the box is closed and the same file placed again: the highlight is back
    await frame.evaluate(REMOVE, story.id);
    await sleep(500);
    await drop(STORY, 'story.pdf');
    await waitInfo('Page 1 of 4', 30000); await settle();
    check('the file placed again shows its highlight in the same place', !!(await until(async () => (await frame.evaluate(() => document.querySelectorAll('.kpv-hl div').length)) === 1, 8000)));
    await L('.kpv [data-act=side]').click(); await L('.kpv-tab[data-tab=notes]').click();
    const cards = await frame.evaluate(() => Array.from(document.querySelectorAll('.kpv-note')).map((c) => c.textContent));
    check('the Notes list has it: its page, the words and the note', cards.length === 1 && /Page 1/.test(cards[0]) && /check the second claim/.test(cards[0]), cards);
    await L('.kpv [data-act=side]').click(); await settle();
    // a click on the mark opens its note
    const hb = await L('.kpv-hl div').first().boundingBox();
    await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2);
    const reopened = await until(async () => frame.evaluate(() => { const t = document.querySelector('.kpv-pop textarea'); return t ? t.value : null; }));
    check('a real click on the yellow mark opens its note box with the note in it', reopened === 'check the second claim', reopened);
    await page.keyboard.press('End'); await page.keyboard.type(' and the third');
    await L('.kpv-pop .go').click();
    await until(async () => { const n = await notesOf(story.id); return n && /third/.test(n.highlights[0].note); }, 8000);
    const n2 = await notesOf(story.id);
    check('an edited note is kept, with an "updated" time not before its "created" time', n2 && n2.highlights[0].note === 'check the second claim and the third' && n2.highlights[0].updated >= n2.highlights[0].created, n2);
    await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await until(async () => frame.evaluate(() => !!document.querySelector('.kpv-pop textarea')));
    await L('.kpv-pop .del').click();
    await until(async () => { const n = await notesOf(story.id); return n && n.highlights.length === 0; }, 8000);
    const n3 = await notesOf(story.id);
    check('removing a highlight takes it away and leaves only its id and the time (so another copy cannot bring it back)', n3 && n3.highlights.length === 0 && n3.removed.length === 1 && Object.keys(n3.removed[0]).sort().join() === 'at,id' && n3.removed[0].id.length >= 6, n3);
    check('and the yellow mark is gone from the page', (await frame.evaluate(() => document.querySelectorAll('.kpv-hl div').length)) === 0);
    check('the notes record is among the sealed documents that "Move my data" carries', docsWith >= 1, docsWith);

    // ---- what the shell keeps beside a file, and refuses ----
    await frame.evaluate(REMOVE, story.id);
    const plain = await drop(PLAIN, 'plain.pdf');
    await waitInfo('Page 1 of 1', 30000); await settle();
    await L('.kpv [data-act=side]').click(); await L('.kpv-tab[data-tab=outline]').click();
    check('a PDF with no outline says so in the outline list', !!(await until(async () => /no outline/.test((await text('.kpv-pane[data-pane=outline]')) || ''))));
    await L('.kpv [data-act=side]').click();
    const put = (doc, id) => keoCall(frame, 'library.notePut', { id: id || plain.id, doc });
    const hlGood = (o) => Object.assign({ id: 'abc123def456', page: 1, rects: [[0.1, 0.1, 0.5, 0.05]], text: 'some words', note: '', created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z' }, o || {});
    const base = await exported();
    let r = await put({ highlights: [hlGood()], removed: [] });
    check('shell: valid notes are accepted', r.ok && r.r === true, r);
    check('shell: ...and are one more document in the sealed data that "Move my data" carries', (await exported()) === base + 1, [base, await exported()]);
    r = await keoCall(frame, 'library.noteGet', { id: plain.id });
    check('shell: ...and read back as they were put', r.ok && r.r.highlights.length === 1 && r.r.highlights[0].text === 'some words' && r.r.highlights[0].rects[0][2] === 0.5, r);
    const refused = async (name, doc, id) => { const x = await put(doc, id); check('shell: ' + name + ' is refused with a sentence', x.ok === false && /not valid|at most|too big/.test(x.e), x); };
    await refused('a highlight on page 0', { highlights: [hlGood({ page: 0 })] });
    await refused('a place outside the page', { highlights: [hlGood({ rects: [[2, 0, 0.1, 0.1]] })] });
    await refused('a place that is not four numbers', { highlights: [hlGood({ rects: [[0.1, 0.1, 0.5]] })] });
    await refused('a highlight with no place', { highlights: [hlGood({ rects: [] })] });
    await refused('two highlights with the same id', { highlights: [hlGood(), hlGood()] });
    await refused('an id with a space in it', { highlights: [hlGood({ id: 'bad id here' })] });
    await refused('a number that is not a number', { highlights: [hlGood({ rects: [[null, 0, 0.1, 0.1]] })] });
    await refused('more than 2000 highlights', { highlights: Array.from({ length: 2001 }, (_, i) => hlGood({ id: 'id' + String(i).padStart(8, '0') })) });
    await refused('something that is not an object', 'words');
    r = await put({ highlights: [hlGood({ text: 'x'.repeat(1500), note: 'y'.repeat(5000) + '\u0007bell' })], removed: [] });
    r = await keoCall(frame, 'library.noteGet', { id: plain.id });
    check('shell: a long text and a long note are cut (1000 and 4000), control characters dropped', r.ok && r.r.highlights[0].text.length === 1000 && r.r.highlights[0].note.length === 4000 && !/\u0007/.test(r.r.highlights[0].note), r);
    r = await put({ highlights: [hlGood()], removed: [] }, 'A'.repeat(43));
    check('shell: notes for a file this identity does not have are not kept (answer false)', r.ok && r.r === false, r);
    r = await put({ highlights: [hlGood()] }, 'short');
    check('shell: notes for a name that is not a file name are refused', r.ok === false, r);
    r = await put({ highlights: [], removed: [] });
    check('shell: notes with nothing in them remove the record', r.ok && (await keoCall(frame, 'library.noteGet', { id: plain.id })).r === null && (await exported()) === base, [r, base, await exported()]);
    r = await keoCall(frame, 'library.put', { objId: 'abcdefghijkl', doc: { objId: 'abcdefghijkl', did: 'x', type: 'pdfnotes', highlights: [] } });
    check('shell: the general library.put refuses a notes document (only notePut writes them)', r.ok === false, r);
    await put({ highlights: [hlGood()], removed: [] });
    check('shell: setup: notes are there again before the file is removed', (await keoCall(frame, 'library.noteGet', { id: plain.id })).r !== null && (await exported()) === base + 1);
    const rt = await page.evaluate(async (id) => {
      const Lib = window.keoLibrary, pack = await Lib.exportSealed();
      await Lib.notePut({ id, doc: { highlights: [], removed: [] } });
      const gone = await Lib.noteGet({ id }), back = await Lib.importSealed(pack), again = await Lib.noteGet({ id });
      return { gone, docs: back.docs, unreadable: back.unreadable, again: again && again.highlights.length };
    }, plain.id);
    check('shell: notes that were exported with the sealed data, removed, and imported again come back (the "Move my data" path)', rt.gone === null && rt.docs === 1 && rt.unreadable === 0 && rt.again === 1, rt);
    r = await keoCall(frame, 'library.fileRemove', { id: plain.id });
    check('shell: removing the file removes its notes with it', r.ok && r.r === true && (await keoCall(frame, 'library.noteGet', { id: plain.id })).r === null && (await exported()) === base, [r, await exported(), base]);

    // ---- the box is still a morph: the toolbar moves it, Ctrl + click brings up its halo ----
    const posOf = (id) => frame.evaluate((i) => { let m = null; $world.withAllSubmorphsDo((x) => { if (x.shape && x.shape.fileObjId === i) m = x; }); return [Math.round(m.getPosition().x), Math.round(m.getPosition().y)]; }, id);
    const p0 = await posOf(plain.id), ib = await L('.kpv .kpv-info').boundingBox();
    await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2); await page.mouse.down(); await page.mouse.move(ib.x + ib.width / 2 + 60, ib.y + ib.height / 2 + 40, { steps: 8 }); await page.mouse.up();
    await sleep(300);
    const p1 = await posOf(plain.id);
    check('dragging the toolbar still moves the box', Math.abs(p1[0] - p0[0] - 60) <= 3 && Math.abs(p1[1] - p0[1] - 40) <= 3, [p0, p1]);
    const vb = await L('.kpv-view').boundingBox();
    await page.keyboard.down('Control'); await page.mouse.click(vb.x + vb.width / 2, vb.y + vb.height - 40); await page.keyboard.up('Control');
    const halo = await until(async () => frame.evaluate((i) => { const t = $world.currentHaloTarget; return !!(t && t.shape && t.shape.fileObjId === i); }, plain.id), 5000);
    check('Ctrl + click on the page brings up the halo of the box (as on any morph)', !!halo);
    await page.mouse.click(1000, 600); await sleep(300);

    // ---- a file that is not a PDF ----
    await frame.evaluate(REMOVE, plain.id);
    await drop(BAD, 'broken.pdf');
    const sad = await until(async () => /Failed to load/.test((await infoText()) || ''), 15000);
    check('a file that is not a PDF is told so in the toolbar (not "Loading…" for ever)', !!sad, await infoText());

    // ---- the page as a whole ----
    check('nothing in the viewer asked anything of the network', outside.length === 0, outside);
    check('no script error in the page the whole time', pageErrors.length === 0, pageErrors);
  } finally {
    await ctx.close().catch(() => {});
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
