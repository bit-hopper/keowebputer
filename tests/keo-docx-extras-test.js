// Word-processor files: footnotes and endnotes, the page header and footer, and text boxes (kernel: lively.data.DocumentUpload docxToHtml).
// The file is built in the page by a small zip writer. Checks: a note's reference becomes a numbered link to the note at the end, which
// links back; the header is shown once at the top and the footer once at the bottom, and a "first page" header is not shown; a text box
// that the file stores twice (the newer and the older drawing of the same box) is shown once, after the paragraph it sits in; a note that
// is not in the file shows no text and breaks nothing; a header part named by a path that leaves the folder is not read; every text is
// escaped and nothing that runs survives; pictures in a header are not shown (they belong to another part). A file with none of these
// is converted as before (the documents suite keeps checking that).
// Usage: node keo-docx-extras-test.js <repo root> <extension folder> <work dir>
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 1200) : '')); if (!ok) failed++; }
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

// Built and converted in the page: returns the clean page text of each file.
const RUN = async () => {
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
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml"';
  const P = (inner) => '<w:p>' + inner + '</w:p>';
  const R = (t) => '<w:r><w:t xml:space="preserve">' + t + '</w:t></w:r>';
  const BOX = (t) => '<w:txbxContent><w:p><w:r><w:t>' + t + '</w:t></w:r></w:p></w:txbxContent>';
  const rels = (items) => '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + items.map(([id, target]) => '<Relationship Id="' + id + '" Type="x" Target="' + target + '"/>').join('') + '</Relationships>';
  const doc = (body, sect) => '<?xml version="1.0" encoding="UTF-8"?><w:document ' + NS + '><w:body>' + body + sect + '</w:body></w:document>';
  const SECT = '<w:sectPr><w:headerReference w:type="first" r:id="rId3"/><w:headerReference w:type="default" r:id="rId1"/><w:footerReference w:type="default" r:id="rId2"/></w:sectPr>';
  const hdr = (inner) => '<?xml version="1.0"?><w:hdr ' + NS + '>' + inner + '</w:hdr>';
  const ftr = (inner) => '<?xml version="1.0"?><w:ftr ' + NS + '>' + inner + '</w:ftr>';
  const notes = (tag, items) => '<?xml version="1.0"?><w:' + tag + 's ' + NS + '><w:' + tag + ' w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:' + tag + '>' + items.map(([id, t]) => '<w:' + tag + ' w:id="' + id + '"><w:p><w:r><w:' + tag + 'Ref/></w:r>' + R(' ' + t) + '</w:p></w:' + tag + '>').join('') + '</w:' + tag + 's>';
  const body = [
    P(R('Body one') + '<w:r><w:footnoteReference w:id="2"/></w:r>' + R(' and again') + '<w:r><w:footnoteReference w:id="2"/></w:r>'),
    P(R('Body two') + '<w:r><w:endnoteReference w:id="3"/></w:r>'),
    P(R('Body three') + '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><a:graphic><a:graphicData><wps:wsp><wps:txbx>' + BOX('Boxed words') + '</wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox>' + BOX('Boxed words') + '</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>'),
    P(R('Body four') + '<w:r><w:pict><v:shape><v:textbox>' + BOX('Old box &lt;b&gt;not bold&lt;/b&gt;') + '</v:textbox></v:shape></w:pict></w:r>'),
    P(R('Body five') + '<w:r><w:footnoteReference w:id="99"/></w:r>'),
    P(R('Body six, with a &lt;script&gt; in words') + '<w:r><w:footnoteReference w:id="4"/></w:r>')
  ].join('');
  const full = makeZip([
    { name: 'word/document.xml', text: doc(body, SECT) },
    { name: 'word/_rels/document.xml.rels', text: rels([['rId1', 'header1.xml'], ['rId2', 'footer1.xml'], ['rId3', 'header2.xml']]) },
    { name: 'word/header1.xml', text: hdr(P(R('Quarterly header')) + '<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><a:blip r:embed="rId9"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>') },
    { name: 'word/header2.xml', text: hdr(P(R('FIRST PAGE HEADER'))) },
    { name: 'word/footer1.xml', text: ftr(P(R('Page footer ') + '<w:fldSimple w:instr="PAGE"><w:r><w:t>7</w:t></w:r></w:fldSimple>')) },
    { name: 'word/footnotes.xml', text: notes('footnote', [['2', 'First note text'], ['4', 'Note with &lt;script&gt;PWNED=1&lt;/script&gt; and more words']]) },
    { name: 'word/endnotes.xml', text: notes('endnote', [['3', 'End note text']]) }
  ]);
  // a header named by a path that leaves the folder, and a file with none of the features
  const escape = makeZip([
    { name: 'word/document.xml', text: doc(P(R('Only body')), '<w:sectPr><w:headerReference w:type="default" r:id="rId1"/></w:sectPr>') },
    { name: 'word/_rels/document.xml.rels', text: rels([['rId1', '../../secret.xml']]) },
    { name: 'secret.xml', text: hdr(P(R('SECRET HEADER'))) }
  ]);
  const plain = makeZip([{ name: 'word/document.xml', text: doc(P(R('Plain body')), '') }]);
  const toHtml = (u8) => lively.data.DocumentUpload.docxToHtml(u8).then((h) => ({ html: h }), (e) => ({ err: e.message }));
  return { full: await toHtml(await full), escape: await toHtml(await escape), plain: await toHtml(await plain), pwned: window.PWNED || null };
};

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-docxextras-' + Date.now()), {
    headless: false, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    await page.goto(`chrome-extension://${ID}/start.html`);
    let frame = await waitForWorld(page, 'gate');
    await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }));
    await keoCall(frame, 'world.go', { kind: 'enter' }).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    await keoCall(frame, 'world.go', { kind: 'blank', name: 'Notes room' }).catch(() => {});
    frame = await waitForWorld(page, 'blank', 'Notes room');

    const r = await frame.evaluate(RUN);
    const h = r.full.html || '', at = (s) => h.indexOf(s), count = (s) => h.split(s).length - 1;
    check('the file is converted (no error)', !r.full.err && h.length > 100, r.full);
    check('the header is shown once, at the top, before the first paragraph', count('Quarterly header') === 1 && at('Quarterly header') < at('Body one') && /<header class="hf">/.test(h), h.slice(0, 400));
    check('a header that is only for the first page is not shown', count('FIRST PAGE HEADER') === 0);
    check('a picture in the header is not shown (it belongs to another part)', !/<img/.test(h), h);
    check('the footer is shown once, at the very end, with its written text and the number last stored in its page field (nothing is calculated)', count('Page footer') === 1 && /<footer class="hf"><p>Page footer 7<\/p><\/footer>/.test(h) && at('Page footer') > at('End note text'), h.slice(-400));
    check('a footnote reference is a numbered link to the note: [1] links to #note-1, the same note referred to twice has the same number, and only the first mention carries the id', count('href="#note-1"') === 2 && /<sup><a href="#note-1" id="ref-1">\[1\]<\/a><\/sup>/.test(h) && count('id="ref-1"') === 1, h.slice(0, 600));
    check('the note is at the end, numbered, links back, and holds its text', /<div id="note-1" class="note"><sup><a href="#ref-1">1<\/a><\/sup>[\s\S]*First note text/.test(h) && at('First note text') > at('Body six'), h.slice(-900));
    check('an endnote gets the next number and its text', /id="note-2"[\s\S]*End note text/.test(h) && /\[2\]/.test(h), h.slice(-900));
    check('each reference and each note has one mark (five references, four notes), and the separator note is not shown', count('<sup>') === 9 && !/separator/.test(h), count('<sup>'));
    check('a note the file does not have still gets its number and breaks nothing (an empty note)', /id="note-3"/.test(h) && /Body five/.test(h), h.slice(-900));
    check('a text box stored twice (new and old drawing) is shown once, in a box, after its paragraph', count('Boxed words') === 1 && /Body three<\/p><blockquote class="box"><p>Boxed words<\/p><\/blockquote>/.test(h), h.slice(0, 900));
    check('an older text box is shown, in a box, with its markup shown as plain text', /Body four<\/p><blockquote class="box"><p>Old box &lt;b&gt;not bold&lt;\/b&gt;<\/p><\/blockquote>/.test(h), h.slice(0, 1200));
    check('words that look like a script stay words, and nothing runs', /Body six, with a &lt;script&gt; in words/.test(h) && !/<script/i.test(h) && /Note with &lt;script&gt;PWNED=1&lt;\/script&gt; and more words/.test(h) && r.pwned === null, [r.pwned, h.slice(-700)]);
    check('a header part named by a path outside the folder is not read', !r.escape.err && /Only body/.test(r.escape.html) && !/SECRET HEADER/.test(r.escape.html), r.escape);
    check('a file with none of these converts to exactly its text', !r.plain.err && r.plain.html === '<p>Plain body</p>', r.plain);
    check('no page errors', errors.length === 0, errors);
  } catch (e) {
    check('the run finished without an exception', false, String(e && e.stack || e));
  }
  await ctx.close();
  console.log(failed ? 'FAILED: ' + failed : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
