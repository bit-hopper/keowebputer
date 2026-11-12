// Small pictures for videos, PDFs and books (kernel: lively.identity.LocalFiles previewKind / _thumbFromVideo / _thumbFromPdf /
// _thumbFromEpub, lively.data.DocumentUpload.epubCoverOf, lively.identity.MyFilesBrowser). Checks: a PDF gets its FIRST page, a video a
// frame and a book its cover, each as a small JPEG made when the file is added (no window open) and read back from the shell; the
// colours are the file's own (page one is red although page two is blue); a file of that kind that cannot be read (a damaged PDF, a
// video the browser cannot decode, a book with no cover, a protected zip) keeps its icon and is not tried again; the limits (50 MB
// for a PDF, 500 MB for a video, 50 MB for a book) keep the icon; older files get theirs the first time a list shows them; the list,
// the grid and the preview pane show them; one that never finishes does not block the next; removing the file removes it.
// PDFs, the video and the books are made in the page: a hand-written PDF with a real cross-reference table, a clip recorded from a
// canvas (webm: the test browser cannot play mp4 video), zip files by a small writer.
// Usage: node keo-thumbs-media-test.js <repo root> <extension folder> <work dir>
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
const click = (frame, sel, opts) => frame.click(sel, Object.assign({ timeout: 8000 }, opts || {}));
const R = (s) => '.mf-root ' + s;

const READ = () => {
  const root = document.querySelector('.mf-root');
  if (!root) return null;
  const list = root.querySelector('.mf-list');
  const prev = root.querySelector('.mf-prev [data-el=thumb]');
  return { grid: list.classList.contains('mf-grid'),
    items: [...root.querySelectorAll('.mf-row')].map((r) => { const im = r.querySelector('img'); const ic = r.querySelector('.mf-ms:not(.mf-chk .mf-ms)');
      return { id: r.dataset.id, name: (r.querySelector('.mf-nmx') || {}).title, sel: r.classList.contains('sel'), img: im ? [im.naturalWidth, im.naturalHeight, im.complete] : null, icon: !im && ic ? ic.innerText : null }; }),
    prevName: ((root.querySelector('.mf-prev .mf-t') || {}).innerText || '').trim(),
    prevImg: prev && prev.querySelector('img') ? (() => { const i = prev.querySelector('img'); return [i.naturalWidth, i.naturalHeight, i.complete]; })() : null };
};
const OPEN = () => new Promise((res) => lively.require('lively.identity.MyFilesBrowser').toRun(() => { lively.identity.MyFilesBrowser.open(); res(); }));

// Made inside the page. window.__m keeps the files.
const MAKE = async () => {
  const m = window.__m = {};
  const enc = new TextEncoder(), NL = String.fromCharCode(10);
  // a PDF of several pages: each page is one filled rectangle in its own colour, MediaBox 300 x 200
  const pdf = (colours, name) => {
    const objs = [null, '<</Type/Pages/Kids[' + colours.map((_, i) => (3 + i * 2) + ' 0 R').join(' ') + ']/Count ' + colours.length + '>>'];
    colours.forEach((c, i) => {
      const content = c + ' rg 0 0 300 200 re f';
      objs.push('<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents ' + (4 + i * 2) + ' 0 R/Resources<<>>>>');
      objs.push('<</Length ' + content.length + '>>' + NL + 'stream' + NL + content + NL + 'endstream');
    });
    objs[0] = '<</Type/Catalog/Pages 2 0 R>>';
    let s = '%PDF-1.4' + NL; const offs = [];
    objs.forEach((o, i) => { offs.push(s.length); s += (i + 1) + ' 0 obj' + NL + o + NL + 'endobj' + NL; });
    const xref = s.length;
    s += 'xref' + NL + '0 ' + (objs.length + 1) + NL + '0000000000 65535 f ' + NL + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n ').join(NL) + NL;
    s += 'trailer<</Size ' + (objs.length + 1) + '/Root 1 0 R>>' + NL + 'startxref' + NL + xref + NL + '%%EOF' + NL;
    return new File([enc.encode(s)], name, { type: 'application/pdf' });
  };
  m.pdf = pdf(['1 0 0', '0 0 1'], 'report.pdf');            // page one red, page two blue
  m.pdf2 = pdf(['0 0.6 0', '0 0 1'], 'older.pdf');
  m.badpdf = new File([enc.encode('%PDF-1.4 this is not really a document at all')], 'damaged.pdf', { type: 'application/pdf' });
  m.hugepdf = new File([new Uint8Array(51 * 1024 * 1024)], 'huge.pdf', { type: 'application/pdf' });
  // a clip: one colour all the way through, 320 x 240 (recorded from a canvas)
  const clip = async (w, h) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' }); const parts = [];
    rec.ondataavailable = (e) => parts.push(e.data); const done = new Promise((r) => (rec.onstop = r));
    rec.start(); for (let i = 0; i < 25; i++) { g.fillStyle = '#2f9e5b'; g.fillRect(0, 0, w, h); g.fillStyle = i % 2 ? '#2f9e5c' : '#2f9e5b'; g.fillRect(0, 0, 4, 4); await new Promise((r) => setTimeout(r, 80)); }
    rec.stop(); await done;
    return new Blob(parts, { type: 'video/webm' });
  };
  m.video = new File([await clip(320, 240)], 'clip.webm', { type: 'video/webm' });
  m.video2 = new File([await clip(160, 90)], 'older.webm', { type: 'video/webm' });
  m.badvideo = new File([new Uint8Array(4000).map((_, i) => (i * 29 + 3) & 255)], 'broken.webm', { type: 'video/webm' });
  // books
  const crcT = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = crcT[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const deflateRaw = async (u8) => { const cs = new CompressionStream('deflate-raw'); const w = cs.writable.getWriter(); w.write(u8); w.close(); return new Uint8Array(await new Response(cs.readable).arrayBuffer()); };
  const makeZip = async (entries) => {
    const parts = [], central = []; let off = 0;
    for (const e of entries) {
      const name = enc.encode(e.name), data = e.store ? e.data : await deflateRaw(e.data), method = e.store ? 0 : 8, crc = crc32(e.data);
      const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
      lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, e.data.length, true); lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true);
      ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, e.data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), name);
      off += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((a, p) => a + p.length, 0);
    const eo = new DataView(new ArrayBuffer(22)); eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, entries.length, true); eo.setUint16(10, entries.length, true); eo.setUint32(12, cdSize, true); eo.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(eo.buffer)]);
  };
  const png = async (w, h, colour) => { const b = await new Promise((r) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = colour; g.fillRect(0, 0, w, h); c.toBlob(r, 'image/png'); }); return new Uint8Array(await b.arrayBuffer()); };
  const CONT = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
  const CH = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter one</h1><p>Words.</p></body></html>';
  const opf = (version, extraItems, extraMeta) => '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="' + version + '"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test</dc:title>' + extraMeta + '</metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' + extraItems + '</manifest><spine><itemref idref="c1"/></spine></package>';
  const book = async (name, opfText, cover) => new File([await makeZip([
    { name: 'mimetype', data: enc.encode('application/epub+zip'), store: true },
    { name: 'META-INF/container.xml', data: enc.encode(CONT) }, { name: 'OEBPS/content.opf', data: enc.encode(opfText) }, { name: 'OEBPS/ch1.xhtml', data: enc.encode(CH) }]
    .concat(cover ? [{ name: 'OEBPS/images/cover.png', data: cover, store: true }] : []))], name, { type: '' });
  const blue = await png(300, 400, '#2563eb'), amber = await png(240, 360, '#e8a317');
  m.epub3 = await book('novel.epub', opf('3.0', '<item id="cv" href="images/cover.png" media-type="image/png" properties="cover-image"/>', ''), blue);
  m.epub2 = await book('classic.epub', opf('2.0', '<item id="art" href="images/cover.png" media-type="image/png"/>', '<meta name="cover" content="art"/>'), amber);
  m.epub2b = await book('older.epub', opf('2.0', '<item id="art" href="images/cover.png" media-type="image/png"/>', '<meta name="cover" content="art"/>'), await png(200, 300, '#9b59b6'));
  m.nocover = await book('plain.epub', opf('3.0', '', ''), null);
  m.note = new File([enc.encode('# Notes\n\nwords')], 'notes.md', { type: '' });
  return { pdf: m.pdf.size, video: m.video.size, epub: m.epub3.size };
};

const PUT = (keys) => keys.length && window.__m && (async () => {
  const out = {};
  for (const k of keys) out[k] = await new Promise((res) => lively.identity.localFiles.put(window.__m[k], {}, (e, r) => res(e ? { err: e.message } : r.id)));
  return out;
})();
// the files go to the library through the shell directly, as files were before small pictures existed (no world, no small picture made)
const PUT_OLD = async (keys) => {
  const out = {};
  for (const k of keys) {
    const f = window.__m[k], bytes = new Uint8Array(await f.arrayBuffer()), L = window.keo;
    const type = lively.identity.localFiles.docTypeOf(f.name) || f.type;
    const b = await L.call('library.fileBegin', { name: f.name, type, size: bytes.length }, 30000);
    await L.call('library.fileChunk', { upload: b.upload, n: 0, bytes: bytes.buffer.slice(0) }, 30000);
    out[k] = (await L.call('library.fileEnd', { upload: b.upload }, 30000)).id;
  }
  return out;
};
// decode a small picture held by the shell: size, a pixel near the top left corner, bytes, JPEG signature
const DECODE = async (ids) => {
  const r = await window.keo.call('library.thumbGet', { ids }, 30000), out = {};
  for (const id of Object.keys(r)) {
    const bm = await createImageBitmap(new Blob([r[id]], { type: 'image/jpeg' })); const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; const g = c.getContext('2d'); g.drawImage(bm, 0, 0);
    const u = new Uint8Array(r[id]);
    out[id] = { w: bm.width, h: bm.height, px: Array.from(g.getImageData(Math.min(8, bm.width - 1), Math.min(8, bm.height - 1), 1, 1).data), bytes: r[id].byteLength, jpeg: u[0] === 0xFF && u[1] === 0xD8 };
  }
  return out;
};
const near = (px, rgb, tol) => rgb.every((v, i) => Math.abs(px[i] - v) <= (tol || 40));

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-thumbsmedia-' + Date.now()), {
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
    await keoCall(frame, 'world.go', { kind: 'blank', name: 'Previews room' }).catch(() => {});
    frame = await waitForWorld(page, 'blank', 'Previews room');

    const sizes = await frame.evaluate(MAKE);
    check('setup: the PDF, the clip and the book were made', sizes.pdf > 300 && sizes.video > 500 && sizes.epub > 500, sizes);

    // ---- which kinds and sizes have a small picture (the limits)
    const kinds = await frame.evaluate(() => {
      const lf = lively.identity.localFiles, MB = 1024 * 1024;
      return { pdf50: lf.previewKind('application/pdf', 50 * MB), pdf51: lf.previewKind('application/pdf', 50 * MB + 1), vid500: lf.previewKind('video/mp4', 500 * MB), vid501: lf.previewKind('video/webm', 500 * MB + 1),
        epub50: lf.previewKind('application/epub+zip', 50 * MB), epub51: lf.previewKind('application/epub+zip', 50 * MB + 1), img: lf.previewKind('image/png', 5), img65: lf.previewKind('image/png', 65 * MB),
        md: lf.previewKind('text/markdown', 5), docx: lf.previewKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 5), aud: lf.previewKind('audio/mpeg', 5), none: lf.previewKind('', 5) };
    });
    check('the limits: a PDF up to 50 MB, a video up to 500 MB, a book up to 50 MB, a picture up to 64 MB; nothing above; no other kind',
      kinds.pdf50 === 'pdf' && kinds.pdf51 === null && kinds.vid500 === 'video' && kinds.vid501 === null && kinds.epub50 === 'epub' && kinds.epub51 === null && kinds.img === 'image' && kinds.img65 === null && kinds.md === null && kinds.docx === null && kinds.aud === null && kinds.none === null, kinds);

    // ---- made when the file is added, with no window open
    const draws0 = await frame.evaluate(() => { window.__draws = []; const lf = lively.identity.localFiles, orig = lf._drawThumb; lf._drawThumb = function (b, kind) { window.__draws.push(kind); return orig.apply(this, arguments); }; });
    const made = await frame.evaluate(PUT, ['pdf', 'badpdf', 'video', 'badvideo', 'epub3', 'epub2', 'nocover', 'note']);
    check('setup: eight files went into the library', Object.values(made).every((v) => typeof v === 'string'), made);
    const good = ['pdf', 'video', 'epub3', 'epub2'].map((k) => made[k]);
    const have = await until(async () => { const r = await keoCall(frame, 'library.thumbGet', { ids: Object.values(made) }); return r.ok && good.every((i) => r.r[i]) ? r.r : null; }, 40000);
    check('a small picture was made for the PDF, the clip and both books when they were added, with no window open', !!have, have && Object.keys(have));
    await sleep(1500);
    const all = (await keoCall(frame, 'library.thumbGet', { ids: Object.values(made) })).r;
    check('and for nothing else: not for the damaged PDF, the video that cannot be decoded, the book with no cover, the markdown file', Object.keys(all).length === 4 && !all[made.badpdf] && !all[made.badvideo] && !all[made.nocover] && !all[made.note], Object.keys(all));
    const d = await frame.evaluate(DECODE, Object.values(made));
    check('every one is a real JPEG and small (under 20 KB here)', good.every((i) => d[i] && d[i].jpeg && d[i].bytes < 20 * 1024), good.map((i) => d[i] && [d[i].jpeg, d[i].bytes]));
    check('the PDF (300 x 200) is 200 x 133 and page ONE is shown: red, although page two is blue', d[made.pdf].w === 200 && d[made.pdf].h === 133 && near(d[made.pdf].px, [255, 0, 0]), d[made.pdf]);
    check('the clip (320 x 240) is 200 x 150 and shows its own colour (green)', d[made.video].w === 200 && d[made.video].h === 150 && near(d[made.video].px, [47, 158, 91]), d[made.video]);
    check('the epub 3 cover (300 x 400, blue) is 150 x 200 and the epub 2 cover (240 x 360, amber) is 133 x 200', d[made.epub3].w === 150 && d[made.epub3].h === 200 && near(d[made.epub3].px, [37, 99, 235]) && d[made.epub2].w === 133 && d[made.epub2].h === 200 && near(d[made.epub2].px, [232, 163, 23]), [d[made.epub3], d[made.epub2]]);
    const kindsDrawn = await frame.evaluate(() => window.__draws.slice().sort().join());
    check('each file was tried once, and only those of a kind that has a small picture (two PDFs, two videos, three books)', kindsDrawn === 'epub,epub,epub,pdf,pdf,video,video', kindsDrawn);

    // ---- limits end to end: a PDF a little over 50 MB keeps its icon and is not even tried
    const huge = await frame.evaluate(async () => { const before = window.__draws.length; const id = await new Promise((res) => lively.identity.localFiles.put(window.__m.hugepdf, {}, (e, r) => res(e ? { err: e.message } : r.id))); await new Promise((r) => setTimeout(r, 1500)); return { id, tried: window.__draws.length - before }; });
    check('a PDF of 51 MB is kept, but no small picture is made or tried for it', typeof huge.id === 'string' && huge.tried === 0 && !((await keoCall(frame, 'library.thumbGet', { ids: [huge.id] })).r[huge.id]), huge);
    made.hugepdf = huge.id;

    // ---- files added before small pictures existed: made the first time a list shows them
    const old = await frame.evaluate(PUT_OLD, ['pdf2', 'video2', 'epub2b']);
    check('setup: three older files are in the library without small pictures', Object.keys((await keoCall(frame, 'library.thumbGet', { ids: Object.values(old) })).r).length === 0, old);
    await frame.evaluate(() => { window.__draws.length = 0; });
    await frame.evaluate(OPEN);
    const names = { [made.pdf]: 'report.pdf', [made.badpdf]: 'damaged.pdf', [made.video]: 'clip.webm', [made.badvideo]: 'broken.webm', [made.epub3]: 'novel.epub', [made.epub2]: 'classic.epub', [made.nocover]: 'plain.epub', [made.note]: 'notes.md', [made.hugepdf]: 'huge.pdf', [old.pdf2]: 'older.pdf', [old.video2]: 'older.webm', [old.epub2b]: 'older.epub' };
    const withPic = ['report.pdf', 'clip.webm', 'novel.epub', 'classic.epub', 'older.pdf', 'older.webm', 'older.epub'];
    let win = await until(async () => { const w = await frame.evaluate(READ); return w && w.items.length === 12 && withPic.every((n) => (w.items.find((i) => i.name === n) || {}).img) ? w : null; }, 40000);
    check('the list shows a small picture for the seven files that have one (the three older ones included)', !!win, await frame.evaluate(READ));
    const by = (w, n) => w.items.find((i) => i.name === n);
    check('the others keep their icon: damaged PDF, broken clip, book with no cover, markdown file, the 51 MB PDF', !!win && ['damaged.pdf', 'broken.webm', 'plain.epub', 'notes.md', 'huge.pdf'].every((n) => !by(win, n).img && by(win, n).icon), win && win.items.filter((i) => !i.img));
    check('each small picture drawn in the list has a size and is loaded', !!win && win.items.filter((i) => i.img).every((i) => i.img[2] && i.img[0] > 0 && Math.max(i.img[0], i.img[1]) <= 200), win && win.items.map((i) => i.img));
    const kinds2 = await frame.evaluate(() => window.__draws.slice().sort().join());
    check('only the three older files were made on the first show (one PDF, one clip, one book): nothing that has one was drawn again and the ones that failed earlier in the session were not tried again', kinds2 === 'epub,pdf,video', kinds2);
    check('and the shell holds seven small pictures now', Object.keys((await keoCall(frame, 'library.thumbGet', { ids: Object.keys(names) })).r).length === 7);
    await page.screenshot({ path: path.join(WORK, 'thumbs-media-list.png') });

    // ---- the preview pane shows the small picture of the chosen file
    const rowOf = (n) => R('.mf-row[data-id="' + Object.keys(names).find((k) => names[k] === n) + '"] .mf-txt');
    await click(frame, rowOf('report.pdf'));
    win = await until(async () => { const w = await frame.evaluate(READ); return w && w.prevName === 'report.pdf' && w.prevImg ? w : null; });
    check('choosing the PDF shows its small picture in the preview pane', !!win && win.prevImg[2] && win.prevImg[0] === 200 && win.prevImg[1] === 133, win && win.prevImg);
    await click(frame, rowOf('damaged.pdf'));
    win = await until(async () => { const w = await frame.evaluate(READ); return w && w.prevName === 'damaged.pdf' ? w : null; });
    check('choosing the damaged PDF shows no picture (its icon stays)', !!win && !win.prevImg, win && win.prevImg);

    // ---- the grid
    await click(frame, R('.mf-seg button[data-view=grid]'));
    win = await until(async () => { const w = await frame.evaluate(READ); return w && w.grid ? w : null; });
    check('the grid shows the small pictures too (seven tiles with a picture)', !!win && win.items.filter((i) => i.img).length === 7, win && win.items.map((i) => [i.name, !!i.img]));
    await frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'MyFilesBrowser'); w.comeForward(); });
    await page.screenshot({ path: path.join(WORK, 'thumbs-media-grid.png') });

    // ---- a window opened in a new session reads them from the shell; the ones that cannot be made are tried once more, no more
    await frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'MyFilesBrowser'); w.remove(); const lf = lively.identity.localFiles; lf._thumbUrls = {}; lf._thumbFail = {}; lf._thumbPending = {}; lf._thumbQ = []; window.__draws.length = 0; });
    await frame.evaluate(OPEN);
    win = await until(async () => { const w = await frame.evaluate(READ); return w && w.items.length === 12 && withPic.every((n) => (by(w, n) || {}).img) ? w : null; }, 30000);
    await sleep(1500);
    const kinds3 = await frame.evaluate(() => window.__draws.slice().sort().join());
    check('opened again with nothing remembered: the seven are read from the shell, only the three that cannot be made (damaged PDF, broken clip, book with no cover) are tried once more', !!win && kinds3 === 'epub,pdf,video', kinds3);

    // ---- one that never finishes does not block the next
    const blocked = await frame.evaluate(async () => {
      const lf = lively.identity.localFiles, saved = { v: lf._thumbFromVideo, t: lf.THUMB_TIMEOUT };
      lf.THUMB_TIMEOUT = 1200;
      lf._thumbFromVideo = function () { /* never answers */ };
      const blob = (n) => new File([window.__m.pdf], n, { type: 'application/pdf' });
      const pdfAgain = new File([await window.__m.pdf.arrayBuffer(), new Uint8Array([10, 10, 10])], 'again.pdf', { type: 'application/pdf' });
      const stuck = new File([await window.__m.video.arrayBuffer(), new Uint8Array([1, 2, 3])], 'stuck.webm', { type: 'video/webm' });
      const ids = {};
      ids.stuck = await new Promise((res) => lf.put(stuck, {}, (e, r) => res(e ? null : r.id)));
      ids.after = await new Promise((res) => lf.put(pdfAgain, {}, (e, r) => res(e ? null : r.id)));
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && !lf.thumbUrl(ids.after)) await new Promise((r) => setTimeout(r, 200));
      const out = { after: !!lf.thumbUrl(ids.after), stuck: !!lf.thumbUrl(ids.stuck), failed: !!lf._thumbFail[ids.stuck], ms: Date.now() - t0 };
      lf._thumbFromVideo = saved.v; lf.THUMB_TIMEOUT = saved.t;
      return out;
    });
    check('a clip whose small picture never arrives is given up after the time limit (not tried again), and the next file still gets its own', blocked.after && !blocked.stuck && blocked.failed, blocked);

    // ---- removing a file removes its small picture
    const before = Object.keys((await keoCall(frame, 'library.thumbGet', { ids: Object.keys(names) })).r).length;
    await frame.evaluate((id) => new Promise((res) => lively.identity.localFiles.remove(id, res)), made.video);
    const after = Object.keys((await keoCall(frame, 'library.thumbGet', { ids: Object.keys(names) })).r).length;
    check('removing a clip removes its small picture', before === 7 && after === 6, [before, after]);

    check('no request left the package', outside.length === 0, outside);
    check('no page errors', errors.length === 0, errors);
  } catch (e) {
    check('the run finished without an exception', false, String(e && e.stack || e));
  }
  await ctx.close();
  console.log(failed ? 'FAILED: ' + failed : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
