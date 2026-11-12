// Documents other than PDF dropped on the world (kernel: lively.data.DocumentUpload, lively.data.EncryptedMedia's EncryptedDocument):
// markdown, plain text, a web page, a book (.epub) and a word-processor file (.docx). Checks: each is kept in the library under a type
// chosen by the ending of its name even when the browser gave the file none; each becomes a document morph holding only a library
// reference; the viewer shows what the file says (headings, bold, lists, tables, a picture that is inside the file, the chapters of a
// book with the names from its table of contents and Prev / Next by real clicks); nothing a file can carry runs or loads (a script, an
// event handler, a remote picture, a link, a style of its own, an inline frame) and the box is a sandboxed frame with a policy of
// its own; a broken file and a zip that expands into too much are refused with a sentence; the Docs filter finds them all; a world
// saved with them shows them again. No request may leave the package.
// SYNTHETIC drops only (a DataTransfer built in the page). Files are made in the page, zip files by a small writer in this test.
// What a person sees (layout, fonts) is judged from the markup and the sandboxed frame's text, not from a picture.
// Usage: node keo-docs-test.js <repo root> <extension folder> <work dir>
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
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

// Made inside the world. window.__d.files holds the files, window.__d.ids their hashes.
const MAKE = async () => {
  const d = window.__d = { files: {}, ids: {} };
  const enc = new TextEncoder();
  const b64u = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).split('+').join('-').split('/').join('_').split('=').join(''); };
  d.cid = async (blob) => b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())));
  const crcT = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = crcT[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const deflateRaw = async (u8) => { const cs = new CompressionStream('deflate-raw'); const w = cs.writable.getWriter(); w.write(u8); w.close(); return new Uint8Array(await new Response(cs.readable).arrayBuffer()); };
  // entries: [{ name, data: Uint8Array, store?: true, lie?: number (a smaller size than the truth is written in the headers) }]
  const makeZip = async (entries) => {
    const parts = [], central = []; let off = 0;
    for (const e of entries) {
      const name = enc.encode(e.name), data = e.store ? e.data : await deflateRaw(e.data), method = e.store ? 0 : 8, usize = e.lie != null ? e.lie : e.data.length, crc = crc32(e.data);
      const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
      lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, usize, true); lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true);
      ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, usize, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), name);
      off += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((a, p) => a + p.length, 0);
    const eo = new DataView(new ArrayBuffer(22)); eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, entries.length, true); eo.setUint16(10, entries.length, true); eo.setUint32(12, cdSize, true); eo.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(eo.buffer)]);
  };
  const png = await new Promise((r) => { const c = document.createElement('canvas'); c.width = 12; c.height = 9; const g = c.getContext('2d'); g.fillStyle = '#c8285a'; g.fillRect(0, 0, 12, 9); c.toBlob(r, 'image/png'); });
  const pngBytes = new Uint8Array(await png.arrayBuffer());
  const F = (blobParts, name, type) => new File(blobParts, name, { type });

  d.files.md = F([enc.encode('# Field notes\n\nSome **bold** words and a [link](https://example.com/x).\n\n<script>window.PWNED = 1</script>\n<img src="https://example.com/p.png" alt="remote picture" onerror="window.PWNED = 2">\n\n![also remote](https://example.com/q.png)\n\n* one\n* two\n\n```\ncode here\n```\n')], 'notes.md', '');
  d.files.txt = F([enc.encode('First line\n<b>not bold</b> & <script>x</script>\nThird line')], 'plain.txt', 'text/plain');
  d.files.html = F([enc.encode('<!doctype html><html><head><title>t</title><style>body{display:none}</style><script>window.PWNED = 3</script></head><body onload="window.PWNED = 4"><h1>Hello page</h1><p style="color:red" onclick="window.PWNED = 5">A <a href="javascript:window.PWNED=6">bad link</a> and <a href="https://example.com/go">a link</a> and <a href="#end">an anchor</a>.</p><iframe src="https://example.com/frame"></iframe><object data="x"></object><img src="https://example.com/r.png" alt="remote one"><form action="https://example.com/post"><input name="q"><button>go</button></form><p id="end">The end</p></body></html>')], 'page.html', 'text/html');
  const OPF = '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Test Book</dc:title></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/><item id="im" href="img/a.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>';
  const NAV = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="ch1.xhtml">Beginning</a></li><li><a href="ch2.xhtml#x">Ending</a></li></ol></nav></body></html>';
  const CH1 = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c1</title><style>body{display:none}</style><script>window.PWNED = 7</script></head><body><h1>Chapter one</h1><p>First <em>chapter</em> text.</p><img src="img/a.png" alt="a dot"/><img src="http://example.com/r.png" alt="remote dot"/><a href="http://example.com">out</a><p onclick="window.PWNED = 8">click</p></body></html>';
  const CH2 = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter two</h1><p>Last words.</p></body></html>';
  d.files.epub = F([await makeZip([
    { name: 'mimetype', data: enc.encode('application/epub+zip'), store: true },
    { name: 'META-INF/container.xml', data: enc.encode('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>') },
    { name: 'OEBPS/content.opf', data: enc.encode(OPF) }, { name: 'OEBPS/nav.xhtml', data: enc.encode(NAV) },
    { name: 'OEBPS/ch1.xhtml', data: enc.encode(CH1) }, { name: 'OEBPS/ch2.xhtml', data: enc.encode(CH2) }, { name: 'OEBPS/img/a.png', data: pngBytes, store: true }])], 'book.epub', '');
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const P = (inner, ppr) => '<w:p>' + (ppr ? '<w:pPr>' + ppr + '</w:pPr>' : '') + inner + '</w:p>';
  const R = (t, rpr) => '<w:r>' + (rpr ? '<w:rPr>' + rpr + '</w:rPr>' : '') + '<w:t xml:space="preserve">' + t + '</w:t></w:r>';
  const LI = (t, num, lvl) => P(R(t), '<w:numPr><w:ilvl w:val="' + (lvl || 0) + '"/><w:numId w:val="' + num + '"/></w:numPr>');
  const cell = (t) => '<w:tc><w:p>' + R(t) + '</w:p></w:tc>';
  const DOC = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + NS + '><w:body>' +
    P(R('Quarterly memo'), '<w:pStyle w:val="Title"/>') + P(R('Summary'), '<w:pStyle w:val="Heading1"/>') +
    P(R('Plain, ') + R('bold', '<w:b/>') + R(' and italic', '<w:i/>') + R(' text &lt;script&gt;window.PWNED = 9&lt;/script&gt; and ') + '<w:hyperlink r:id="rId9">' + R('a site') + '</w:hyperlink>') +
    LI('First point', 1) + LI('Second point', 1) + LI('Nested point', 1, 1) + LI('Third point', 1) + LI('Step one', 2) + LI('Step two', 2) +
    '<w:tbl><w:tr>' + cell('A1') + cell('B1') + '</w:tr><w:tr>' + cell('A2') + cell('B2') + '</w:tr></w:tbl>' +
    P('<w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>') +
    P(R('Last paragraph')) + '</w:body></w:document>';
  const STYLES = '<?xml version="1.0"?><w:styles ' + NS + '><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>';
  const NUMB = '<?xml version="1.0"?><w:numbering ' + NS + '><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>';
  const RELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="x/image" Target="media/p.png"/><Relationship Id="rId9" Type="x/hyperlink" Target="https://example.com/site" TargetMode="External"/></Relationships>';
  d.files.docx = F([await makeZip([
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
    { name: 'word/document.xml', data: enc.encode(DOC) }, { name: 'word/styles.xml', data: enc.encode(STYLES) }, { name: 'word/numbering.xml', data: enc.encode(NUMB) },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(RELS) }, { name: 'word/media/p.png', data: pngBytes, store: true }])], 'memo.docx', '');
  d.files.bad = F([enc.encode('this is not a zip file at all, just words')], 'broken.docx', '');
  d.files.bomb = F([await makeZip([{ name: 'word/document.xml', data: new Uint8Array(60 * 1024 * 1024), lie: 100 }])], 'bomb.docx', '');
  for (const k of Object.keys(d.files)) d.ids[k] = await d.cid(d.files[k]);
  return Object.fromEntries(Object.keys(d.files).map((k) => [k, { size: d.files[k].size, id: d.ids[k] }]));
};
const DROP = ([key, x, y]) => {
  const dt = new DataTransfer(); [].concat(key).forEach((k) => dt.items.add(window.__d.files[k]));
  const el = document.elementFromPoint(x, y);
  const mk = (type) => new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y });
  el.dispatchEvent(mk('dragenter')); el.dispatchEvent(mk('dragover')); el.dispatchEvent(mk('drop'));
  return true;
};
// what a document box shows, found by the file's id in the library
const VIEW = (id) => {
  let m = null; $world.withAllSubmorphsDo((x) => { if (x.shape && x.shape.fileObjId === id) m = x; });
  if (!m) return null;
  const root = m.shape.shapeNode, f = root.querySelector('iframe'), sel = root.querySelector('select');
  const src = f ? f.getAttribute('srcdoc') : null;
  const body = src ? new DOMParser().parseFromString(src, 'text/html').body : null;
  return { type: m.constructor.type || m.constructor.name, handle: m.shape.fileHandle, mime: m.shape.mime, name: m.shape.docName, srcdoc: src, sandbox: f ? f.getAttribute('sandbox') : null,
    html: body ? body.innerHTML : null, text: body ? body.textContent : null, options: sel ? Array.from(sel.options).map((o) => o.textContent) : null, picked: sel ? sel.value : null,
    buttons: Array.from(root.querySelectorAll('button')).map((b) => b.textContent + (b.disabled ? ' (off)' : '')), bar: Array.from(root.querySelectorAll('span')).map((s) => s.textContent).join('|'),
    box: [Math.round(m.getExtent().x), Math.round(m.getExtent().y)] };
};
const REMOVE = (id) => { let m = null; $world.withAllSubmorphsDo((x) => { if (x.shape && x.shape.fileObjId === id) m = x; }); m.remove(); };
const MOVE_AWAY = ([id, n]) => {
  let m = null; $world.withAllSubmorphsDo((x) => { if (x.shape && x.shape.fileObjId === id) m = x; });
  m.setExtent(pt(280, 210)); m.setPosition(pt(660 + (n % 2) * 300, 10 + Math.floor(n / 2) * 220));
};

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-docs-' + Date.now()), {
    headless: false, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  const logsRef = [], errorsRef = [];
  try {
    const page = await ctx.newPage();
    const errors = errorsRef, outside = [];
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    const logs = logsRef;
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ' ' + m.text().slice(0, 300)); });
    page.on('request', (rq) => {
      const u = rq.url();
      if (/^(chrome-extension|blob|data|about):/.test(u) || /youtube\.com\/iframe_api$/.test(u)) return;
      outside.push(rq.method() + ' ' + u.slice(0, 100));
    });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });

    await page.goto(`chrome-extension://${ID}/start.html`);
    let frame = await waitForWorld(page, 'gate');
    await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }));
    await frame.evaluate(() => window.keo.call('world.go', { kind: 'blank' }, 120000)).catch(() => {});
    frame = await waitForWorld(page, 'blank');
    const made = await frame.evaluate(MAKE);
    const info = (id) => frame.evaluate((i) => window.keo.call('library.fileInfo', { id: i }, 30000), id);
    const view = async (id, ready) => {
      let v = null;
      for (let i = 0; i < 40; i++) { v = await frame.evaluate(VIEW, id); if (v && v.srcdoc && (!ready || ready(v))) return v; await sleep(250); }
      return v;
    };
    let slot = 0;
    const drop = async (k) => { await frame.evaluate(DROP, [k, 40, 70]); await sleep(2500); };
    const away = async (k) => { await frame.evaluate(MOVE_AWAY, [made[k].id, slot++]); await sleep(300); };
    const gone = async (k) => { await frame.evaluate(REMOVE, made[k].id); await sleep(300); };      // the library keeps the file; only the box goes

    // ---- markdown
    await drop('md');
    let v = await view(made.md.id);
    const im = await info(made.md.id);
    check('markdown: kept in the library under its name and the markdown type, although the browser gave the file no type', im && im.name === 'notes.md' && im.type === 'text/markdown', im);
    check('markdown: a document morph holding a library reference', v && /EncryptedDocument/.test(v.type) && v.handle === 'keo:local' && v.mime === 'text/markdown', v && [v.type, v.handle, v.mime]);
    check('markdown: the box is a frame with an empty sandbox (nothing is allowed)', v && v.sandbox === '', v && v.sandbox);
    check('markdown: heading, bold text, list and code block are shown', v && /<h1[^>]*>Field notes<\/h1>/.test(v.html) && /<strong>bold<\/strong>/.test(v.html) && (v.html.match(/<li>/g) || []).length === 2 && /<pre><code>code here/.test(v.html), v && v.html);
    check('markdown: the page carries a content policy of its own that allows no script and no remote picture', v && /Content-Security-Policy[^>]*default-src 'none'; img-src data:/.test(v.srcdoc), v && v.srcdoc.slice(0, 300));
    check('markdown: no script, no event handler, no remote picture or link in what is shown', v && !/<script|onerror|onclick|javascript:|(src|href)="https?:|<iframe|<object|<form/.test(v.html), v && v.html);
    check('markdown: a link is shown but goes nowhere (no href)', v && /<a [^>]*class="ext"[^>]*>link<\/a>/.test(v.html) && !/<a [^>]*href="https/.test(v.html), v && v.html);
    check('markdown: the text of a remote picture is kept in its place', v && /\[also remote\]/.test(v.text), v && v.text);
    await gone('md');

    // ---- plain text
    await drop('txt');
    v = await view(made.txt.id);
    check('text: a document morph, kept as text/plain', v && /EncryptedDocument/.test(v.type) && v.mime === 'text/plain', v && v.mime);
    check('text: shown exactly as written (markup is text, not markup)', v && /First line\n<b>not bold<\/b> &amp; <script>x<\/script>\nThird line|First line\n<b>not bold<\/b> & <script>x<\/script>\nThird line/.test(v.text) && !/<b>/.test(v.html.replace(/&lt;b&gt;/g, '')), v && v.html);
    await gone('txt');

    // ---- web page
    await drop('html');
    v = await view(made.html.id);
    check('web page: a document morph, kept as text/html', v && /EncryptedDocument/.test(v.type) && v.mime === 'text/html', v && v.mime);
    check('web page: its words are shown', v && /Hello page/.test(v.text) && /The end/.test(v.text) && /bad link/.test(v.text), v && v.text);
    check('web page: no script, style, event handler, frame, object, form, remote picture or javascript: address', v && !/<script|<style|onload|onclick|style=|<iframe|<object|<form|<input|<button|javascript:|(src|href)="https?:/.test(v.html), v && v.html);
    check('web page: an address inside the page (#end) still works, an outside link shows its address on hover and goes nowhere', v && /<a href="#end">an anchor<\/a>/.test(v.html) && /<a class="ext" title="https:\/\/example\.com\/go">a link<\/a>/.test(v.html), v && v.html);
    await gone('html');

    // ---- book
    await drop('epub');
    v = await view(made.epub.id);
    const ie = await info(made.epub.id);
    check('book: kept under the book type although the browser gave no type', ie && ie.name === 'book.epub' && ie.type === 'application/epub+zip', ie);
    check('book: the chapter list has the names from the table of contents', v && v.options && v.options.join('|') === 'Beginning|Ending', v && v.options);
    check('book: the first chapter is shown, with the picture inside the file as a data picture', v && /Chapter one/.test(v.text) && /<img src="data:image\/png;base64,/.test(v.html), v && v.html);
    check('book: no script, style or event handler; the remote picture is not shown; its words stand in its place', v && !/<script|<style|onclick|example\.com\/r|src="http/.test(v.html) && /\[remote dot\]/.test(v.text) && !/PWNED/.test(v.text.replace(/click/g, '')), v && v.html);
    check('book: Prev is off on the first chapter', v && v.buttons.some((b) => /Prev/.test(b) && /\(off\)/.test(b)) && v.buttons.some((b) => /Next/.test(b) && !/\(off\)/.test(b)), v && v.buttons);
    await frame.locator('button', { hasText: 'Next ›' }).click();
    await sleep(800);
    v = await view(made.epub.id, (x) => /Chapter two/.test(x.text || ''));
    check('book: a real click on Next shows the second chapter and selects it in the list', v && /Chapter two/.test(v.text) && /Last words/.test(v.text) && v.picked === '1', v && [v.picked, v.text]);
    check('book: Next is off on the last chapter', v && v.buttons.some((b) => /Next/.test(b) && /\(off\)/.test(b)), v && v.buttons);
    await frame.locator('button', { hasText: '‹ Prev' }).click();
    await sleep(800);
    v = await view(made.epub.id, (x) => /Chapter one/.test(x.text || ''));
    check('book: a real click on Prev goes back', v && /Chapter one/.test(v.text) && v.picked === '0', v && [v.picked, v.text]);
    const sizeBefore = (await frame.evaluate(VIEW, made.epub.id)).srcdoc.match(/font:(\d+)%/);
    await frame.locator('button', { hasText: 'A+' }).click();
    await sleep(600);
    const sizeAfter = (await frame.evaluate(VIEW, made.epub.id)).srcdoc.match(/font:(\d+)%/);
    check('book: A+ makes the text larger (real click)', sizeBefore && sizeAfter && Number(sizeAfter[1]) > Number(sizeBefore[1]), [sizeBefore && sizeBefore[1], sizeAfter && sizeAfter[1]]);
    await away('epub');

    // ---- word-processor file
    await drop('docx');
    v = await view(made.docx.id);
    const id = await info(made.docx.id);
    check('docx: kept under the word-processor type although the browser gave no type', id && id.name === 'memo.docx' && id.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', id);
    check('docx: the title style and the heading are shown as headings', v && /<h1[^>]*class="title"[^>]*>Quarterly memo<\/h1>/.test(v.html) && /<h1[^>]*>Summary<\/h1>/.test(v.html), v && v.html);
    check('docx: bold and italic runs are shown', v && /<strong>bold<\/strong>/.test(v.html) && /<em> and italic<\/em>/.test(v.html), v && v.html);
    check('docx: a bulleted list, a numbered list and a nested bullet are lists', v && /<ul><li>First point<\/li><li>Second point<ul><li>Nested point<\/li><\/ul><\/li><li>Third point<\/li><\/ul>/.test(v.html) && /<ol><li>Step one<\/li><li>Step two<\/li><\/ol>/.test(v.html), v && v.html);
    check('docx: the table has its two rows and four cells', v && (v.html.match(/<tr>/g) || []).length === 2 && (v.html.match(/<td>/g) || []).length === 4 && /<td><p>A2<\/p><\/td>/.test(v.html), v && v.html);
    check('docx: the picture inside the file is shown as a data picture', v && /<img src="data:image\/png;base64,/.test(v.html), v && v.html);
    check('docx: markup written in the text is text, and no script or address is carried', v && /&lt;script&gt;window\.PWNED = 9/.test(v.html) && !/<script|example\.com/.test(v.html), v && v.html);
    await away('docx');

    // ---- files that cannot be shown
    await drop('bad');
    v = await view(made.bad.id);
    check('a file named .docx that is not a zip: a sentence says it cannot be opened, nothing else is shown', v && /could not be opened/.test(v.bar) && /not a valid zip-based file/.test(v.text), v && [v.bar, v.text]);
    await away('bad');
    await drop('bomb');
    v = await view(made.bomb.id);
    check('a zip that expands into more than is allowed (its headers lie about the size): refused with a sentence', v && /could not be opened/.test(v.bar) && /too large/.test(v.text), v && [v.bar, v.text]);
    await away('bomb');

    // ---- the library
    const kinds = await frame.evaluate(() => lively.identity.localFiles.DOC_KINDS);
    const found = await frame.evaluate((k) => window.keo.call('library.fileSearch', { query: '', type: k, limit: 50 }, 30000), kinds);
    check('the Docs filter (a list of kinds) finds the seven document files', found.total === 7 && found.items.every((i) => /docx|epub|md|txt|html/.test(i.name)), found);
    const pics = await frame.evaluate(() => window.keo.call('library.fileSearch', { query: '', type: 'image/', limit: 50 }, 30000));
    check('...and the Pictures filter finds none of them', pics.total === 0, pics);
    check('a library file that is not a document is not a document kind', await frame.evaluate(() => !lively.identity.localFiles.isDocType('image/png') && !lively.identity.localFiles.isDocType('application/octet-stream') && lively.identity.localFiles.isDocType('application/pdf') && lively.identity.localFiles.isDocType('text/markdown')));
    check('no script of any file ran in the world', await frame.evaluate(() => typeof window.PWNED === 'undefined'));
    check('no request left the package', outside.length === 0, outside);

    // ---- placed from My files: the same viewer
    const placed = await frame.evaluate(async (id) => new Promise((res) => {
      const n0 = (() => { let c = 0; $world.withAllSubmorphsDo((m) => { if (m.shape && m.shape.fileObjId === id) c++; }); return c; })();
      lively.data.FileUpload.placeLibraryFile({ name: 'notes.md', type: 'application/octet-stream', size: 1, ref: { handle: 'keo:local', objId: id, blobCid: id } }, (e) => {
        setTimeout(() => { let c = 0; $world.withAllSubmorphsDo((m) => { if (m.shape && m.shape.fileObjId === id) c++; }); res({ err: e && e.message, n0, n1: c }); }, 1500);
      });
    }), made.md.id);
    check('Place in world from the library makes a document box for the file, even when the library has it under an unknown type (the ending of the name decides)', !placed.err && placed.n1 === placed.n0 + 1, placed);

    // ---- a saved world shows them again
    const saved = await frame.evaluate(() => new Promise((res) => $world.saveWorldAs(URL.root.withFilename('docsworld.html'), false, undefined, (e) => res(e ? { err: e.message } : { ok: true }))));
    check('the world saves', saved.ok === true, saved);
    const list = await frame.evaluate(() => window.keo.call('world.list', {}, 30000));
    const row = list.find((w) => w.name === 'docsworld');
    check('the saved world holds references, not the documents (small)', row && row.bytes < 300000, row);
    await page.reload();
    frame = await waitForWorld(page, 'world');
    await sleep(3500);
    for (const [k, what, re] of [['docx', 'word-processor file', /Quarterly memo/], ['epub', 'book', /Chapter one/], ['md', 'markdown file placed from the library', /Field notes/]]) {
      const r = await view(made[k].id);
      check('opened again: the ' + what + ' is back and shows its text', r && /EncryptedDocument/.test(r.type) && re.test(r.text) && r.sandbox === '', r && [r.type, r.sandbox, (r.text || '').slice(0, 80)]);
    }
    const r2 = await view(made.epub.id);
    check('opened again: the book still has its chapter list', r2 && r2.options && r2.options.join('|') === 'Beginning|Ending', r2 && r2.options);
    const drawn = await frame.evaluate((ids) => ids.map((id) => { let f = null; $world.withAllSubmorphsDo((x) => { if (x.shape && x.shape.fileObjId === id && !f) f = x; }); const r = f.renderContext().morphNode.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), Math.round(f.getExtent().x), Math.round(f.getExtent().y)]; }), [made.docx.id, made.epub.id]);
    check('opened again: the boxes are DRAWN at the size they report (not 0 x 0 or 2 x 2)', drawn.every((d) => d[0] > 100 && d[1] > 100 && Math.abs(d[0] - d[2]) <= 2 && Math.abs(d[1] - d[3]) <= 2), drawn);
    check('no request left the package at any point', outside.length === 0, outside);
    check('no script of any file ran in the world after the reopening', await frame.evaluate(() => typeof window.PWNED === 'undefined'));
    console.log('INFO page errors ' + JSON.stringify(errors) + '; console ' + JSON.stringify(logs.filter((l) => !/iframe_api|Geolocation|ERR_FILE_NOT_FOUND/.test(l)).slice(0, 8)));
    await page.screenshot({ path: path.join(WORK, 'docs-after.png') });
  } catch (e) { console.log('INFO console so far ' + JSON.stringify(logsRef.filter((l) => !/iframe_api|Geolocation|ERR_FILE_NOT_FOUND|compute-pressure|pubKeyCred/.test(l)).slice(-12)) + ' errors ' + JSON.stringify(errorsRef)); throw e; } finally { await ctx.close(); }
  console.log(failed ? failed + ' FAILED' : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(1); });
