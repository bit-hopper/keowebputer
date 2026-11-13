// Dropping files onto the world (kernel: lively.identity.LocalFiles, the upload handlers, lively.data.EncryptedMedia). A dropped picture or
// video goes into the library in slices and the world keeps only a small reference; what is shown is a blob made inside the world from
// the slices. Checks: the file is in the library with its name, type and size and is named by the hash of its bytes; the morph holds
// the reference and nothing else about the bytes; it really displays (a picture decodes, a video loads its metadata); a file larger
// than one slice (two slices) comes out byte for byte; the same file dropped twice is kept once; a world holds no copy of the bytes
// (the saved text stays small); nobody signed in gets a sentence and nothing is stored; no request leaves the package.
// SYNTHETIC drops only: a DataTransfer built in the page and dispatched as drag events. A drag from the operating system was NOT tried.
// Usage: node keo-drop-test.js <repo root> <extension folder> <work dir>
// A headed browser with the extension loaded, `localhost` unresolvable, a virtual authenticator with PRF.
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 900) : '')); if (!ok) failed++; }
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

// Made inside the world so the bytes never cross the test's own channel. window.__d keeps the files and their hashes.
const MAKE = async () => {
  const d = window.__d = { files: {}, ids: {} };
  const b64u = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).split('+').join('-').split('/').join('_').split('=').join(''); };
  d.cid = async (blob) => b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())));
  const canvasPng = async (w, h, noise) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
    const im = g.createImageData(w, h); let x = 12345;
    for (let i = 0; i < im.data.length; i += 4) {
      if (noise) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; im.data[i] = x & 255; im.data[i + 1] = (x >>> 8) & 255; im.data[i + 2] = (x >>> 16) & 255; }
      else { im.data[i] = 200; im.data[i + 1] = 40; im.data[i + 2] = 90; }
      im.data[i + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    return new Promise((r) => c.toBlob(r, 'image/png'));
  };
  d.files.small = new File([await canvasPng(40, 30, false)], 'small.png', { type: 'image/png' });
  d.files.big = new File([await canvasPng(1500, 1500, true)], 'Holiday photo.png', { type: 'image/png' });
  const c = document.createElement('canvas'); c.width = 64; c.height = 48; const g = c.getContext('2d');
  const rec = new MediaRecorder(c.captureStream(10), { mimeType: 'video/webm' }); const parts = [];
  rec.ondataavailable = (e) => parts.push(e.data); const done = new Promise((r) => (rec.onstop = r));
  rec.start(); for (let i = 0; i < 8; i++) { g.fillStyle = 'hsl(' + i * 40 + ',80%,50%)'; g.fillRect(0, 0, 64, 48); await new Promise((r) => setTimeout(r, 120)); }
  rec.stop(); await done;
  d.files.video = new File([new Blob(parts, { type: 'video/webm' })], 'clip.webm', { type: 'video/webm' });
  // a real one-page PDF (200 x 100, filled red), with its cross-reference table worked out
  const NL = String.fromCharCode(10);
  const content = '1 0 0 rg 0 0 200 100 re f';
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<<>>>>',
    '<</Length ' + content.length + '>>' + NL + 'stream' + NL + content + NL + 'endstream'];
  let pdf = '%PDF-1.4' + NL; const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += (i + 1) + ' 0 obj' + NL + o + NL + 'endobj' + NL; });
  const xref = pdf.length;
  pdf += 'xref' + NL + '0 5' + NL + '0000000000 65535 f ' + NL + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n ' + NL).join('') + 'trailer' + NL + '<</Size 5/Root 1 0 R>>' + NL + 'startxref' + NL + xref + NL + '%%EOF' + NL;
  d.files.pdf = new File([new TextEncoder().encode(pdf)], 'doc.pdf', { type: 'application/pdf' });
  // a Standard MIDI File: one track, middle C for one beat
  d.files.midi = new File([Uint8Array.from([0x4d,0x54,0x68,0x64,0,0,0,6,0,0,0,1,1,0xe0, 0x4d,0x54,0x72,0x6b,0,0,0,13, 0,0x90,0x3c,0x40, 0x83,0x60,0x80,0x3c,0x40, 0,0xff,0x2f,0])], 'tune.mid', { type: 'audio/midi' });
  const wav = new Uint8Array(44 + 8000), dv = new DataView(wav.buffer);       // one second of silence, 8 kHz, 8 bit mono
  'RIFF'.split('').forEach((ch, i) => (wav[i] = ch.charCodeAt(0))); dv.setUint32(4, 36 + 8000, true);
  'WAVEfmt '.split('').forEach((ch, i) => (wav[8 + i] = ch.charCodeAt(0))); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  'data'.split('').forEach((ch, i) => (wav[36 + i] = ch.charCodeAt(0))); dv.setUint32(40, 8000, true); for (let i = 0; i < 8000; i++) wav[44 + i] = 128 + Math.round(100 * Math.sin(2 * Math.PI * 440 * i / 8000));   // a 440 Hz tone
  d.files.wav = new File([wav], 'sound.wav', { type: 'audio/wav' });
  for (let i = 1; i <= 4; i++) {                                                  // four different small pictures, for one drop
    const c4 = document.createElement('canvas'); c4.width = 20 + i; c4.height = 20; const g4 = c4.getContext('2d'); g4.fillStyle = 'hsl(' + i * 70 + ',70%,50%)'; g4.fillRect(0, 0, 40, 40);
    d.files['p' + i] = new File([await new Promise((r) => c4.toBlob(r, 'image/png'))], 'p' + i + '.png', { type: 'image/png' });
  }
  const c5 = document.createElement('canvas'); c5.width = 1500; c5.height = 1500; const g5 = c5.getContext('2d'); const im5 = g5.createImageData(1500, 1500); let x5 = 99991;
  for (let i = 0; i < im5.data.length; i += 4) { x5 ^= x5 << 13; x5 >>>= 0; x5 ^= x5 >>> 17; x5 ^= x5 << 5; x5 >>>= 0; im5.data[i] = x5 & 255; im5.data[i + 1] = (x5 >>> 8) & 255; im5.data[i + 2] = (x5 >>> 16) & 255; im5.data[i + 3] = 255; }
  g5.putImageData(im5, 0, 0);
  d.files.big2 = new File([await new Promise((r) => c5.toBlob(r, 'image/png'))], 'second big.png', { type: 'image/png' });
  const huge = new Uint8Array(100 * 1024 * 1024); let xh = 7;                      // 100 MB that no player can decode: this is about the bytes
  for (let i = 0; i < huge.length; i += 4096) { xh ^= xh << 13; xh >>>= 0; xh ^= xh >>> 17; xh ^= xh << 5; xh >>>= 0; huge[i] = xh & 255; huge[i + 1] = i & 255; }
  d.files.huge = new File([huge], 'long film.mp4', { type: 'video/mp4' });
  for (const k of Object.keys(d.files)) d.ids[k] = await d.cid(d.files[k]);
  return Object.fromEntries(Object.keys(d.files).map((k) => [k, { size: d.files[k].size, id: d.ids[k] }]));
};
// the world's morphs that hold a library reference, and the notices on screen
const SURVEY = () => {
  const refs = [], notes = [];
  $world.withAllSubmorphsDo((m) => {
    if (m.shape && m.shape.fileHandle) refs.push({ type: m.constructor.type || m.constructor.name, handle: m.shape.fileHandle, objId: m.shape.fileObjId, mime: m.shape.mime || null });
    if (typeof m.textString === 'string' && /Error uploading|Sign in|sign in|not in this device|unknown type|MIDI files/i.test(m.textString)) notes.push(m.textString.slice(0, 200));
  });
  return { refs, notes };
};
const DROP = ([key, x, y]) => {
  const dt = new DataTransfer(); [].concat(key).forEach((k) => dt.items.add(window.__d.files[k]));
  const el = document.elementFromPoint(x, y);
  const mk = (type) => new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y });
  el.dispatchEvent(mk('dragenter')); el.dispatchEvent(mk('dragover')); el.dispatchEvent(mk('drop'));
  return true;
};

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-drop-' + Date.now()), {
    headless: false, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  try {
    const page = await ctx.newPage();
    const errors = [], outside = [], logs = [];
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 300)); });
    const pdfjs = [];
    page.on('request', (rq) => {
      const u = rq.url();
      if (/^(chrome-extension|blob|data):/.test(u) || /youtube\.com\/iframe_api$/.test(u)) return;      // the home world's video player, blocked by the page
      if (/pdf\.js/.test(u)) pdfjs.push(u); else outside.push(rq.method() + ' ' + u.slice(0, 100));
    });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });

    // ---- nobody signed in: the gate world. A drop gets a sentence and stores nothing.
    await page.goto(`chrome-extension://${ID}/start.html`);
    let frame = await waitForWorld(page, 'gate');
    let made = await frame.evaluate(MAKE);
    await frame.evaluate(DROP, ['small', 600, 500]);
    await sleep(2500);
    let sv = await frame.evaluate(SURVEY);
    check('nobody signed in: a dropped picture makes no picture in the world', sv.refs.length === 0, sv);
    check('nobody signed in: the person is told to sign in', sv.notes.some((t) => /sign in/i.test(t)), sv);
    check('nobody signed in: no request left the package', outside.length === 0, outside);

    // ---- signed in
    const did = (await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }))).did;
    await frame.evaluate(() => window.keo.call('world.go', { kind: 'enter' }, 60000)).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    made = await frame.evaluate(MAKE);
    const info = (id) => frame.evaluate((i) => window.keo.call('library.fileInfo', { id: i }, 30000), id);
    const shown = (id, tag) => frame.evaluate(({ id, tag }) => {
      const url = lively.identity.localFiles._urls && lively.identity.localFiles._urls[id];
      const els = Array.from(document.querySelectorAll(tag)).filter((e) => url && (e.currentSrc === url || e.src === url || e.getAttribute('src') === url || (e.querySelector && e.querySelector('source') && e.querySelector('source').src === url)));
      return els.map((e) => ({ w: e.naturalWidth || e.videoWidth || null, h: e.naturalHeight || e.videoHeight || null, complete: e.complete, ready: e.readyState === undefined ? null : e.readyState, dur: e.duration }));
    }, { id, tag });

    // picture, one slice
    await frame.evaluate(DROP, ['small', 500, 450]);
    await sleep(3000);
    sv = await frame.evaluate(SURVEY);
    const pic = sv.refs.filter((r) => r.objId === made.small.id);
    check('a dropped picture becomes a picture morph holding a library reference', pic.length === 1 && /EncryptedImage/.test(pic[0].type) && pic[0].handle === 'keo:local', sv);
    check('no notice of an upload error', sv.notes.length === 0, sv);
    let i1 = await info(made.small.id);
    check('the picture is in the library with its name, type and size', i1 && i1.name === 'small.png' && i1.type === 'image/png' && i1.size === made.small.size && i1.chunks === 1, i1);
    let s1 = await shown(made.small.id, 'img');
    check('the picture is on screen and decoded (40 x 30)', s1.length >= 1 && s1[0].w === 40 && s1[0].h === 30, s1);

    // picture, two slices
    check('setup: the big picture is larger than one slice', made.big.size > 4 * 1024 * 1024, made.big.size);
    await frame.evaluate(DROP, ['big', 600, 500]);
    await sleep(6000);
    sv = await frame.evaluate(SURVEY);
    check('a picture of two slices becomes a picture morph', sv.refs.filter((r) => r.objId === made.big.id).length === 1, sv);
    const i2 = await info(made.big.id);
    check('it is stored in two slices under its name', i2 && i2.chunks === 2 && i2.name === 'Holiday photo.png' && i2.size === made.big.size, i2);
    const s2 = await shown(made.big.id, 'img');
    check('it is on screen and decoded (1500 x 1500)', s2.length >= 1 && s2[0].w === 1500 && s2[0].h === 1500, s2);
    const same = await frame.evaluate(async (id) => { const b = await new Promise((res, rej) => lively.identity.localFiles.blobFor(id, (e, bl) => e ? rej(e) : res(bl))); return (await window.__d.cid(b)) === id && b.size === window.__d.files.big.size; }, made.big.id);
    check('the bytes read back from the library are the bytes that were dropped', same === true);

    // the same file twice
    const before = await frame.evaluate(() => window.keo.call('library.fileSearch', { query: '', limit: 200 }, 30000));
    await frame.evaluate(DROP, ['small', 700, 600]);
    await sleep(3000);
    const after = await frame.evaluate(() => window.keo.call('library.fileSearch', { query: '', limit: 200 }, 30000));
    sv = await frame.evaluate(SURVEY);
    check('the same picture dropped twice is kept once in the library', after.total === before.total, [before.total, after.total]);
    check('...and shown twice', sv.refs.filter((r) => r.objId === made.small.id).length === 2, sv);

    // no room: the browser says there is none (its estimate is replaced in the shell page for this drop), so the person is told in the
    // shell's own words and nothing is kept or shown. A file already in the library is refused too: its name is known only at the end.
    await page.evaluate(() => { navigator.storage.estimate = async () => ({ quota: 1000 * 1048576, usage: 990 * 1048576 }); });
    const refs0 = sv.refs.length, filesTotal0 = (await frame.evaluate(() => window.keo.call('library.fileSearch', { query: '', limit: 1 }, 30000))).total;
    await frame.evaluate(DROP, ['small', 800, 400]);
    await sleep(3000);
    sv = await frame.evaluate(SURVEY);
    check('a drop the browser has no room for: the person is told the library is full and why', sv.notes.some((t) => /The library is full: this browser has no room left and this file needs/.test(t)), sv.notes);
    check('...no morph is made and nothing is added to the library', sv.refs.length === refs0 && (await frame.evaluate(() => window.keo.call('library.fileSearch', { query: '', limit: 1 }, 30000))).total === filesTotal0, [sv.refs.length, refs0]);
    await page.evaluate(() => { delete navigator.storage.estimate; });

    // video
    await frame.evaluate(DROP, ['video', 300, 300]);
    await sleep(4000);
    sv = await frame.evaluate(SURVEY);
    const vid = sv.refs.filter((r) => r.objId === made.video.id);
    check('a dropped video becomes a video morph holding a library reference', vid.length === 1 && /EncryptedVideo/.test(vid[0].type) && vid[0].handle === 'keo:local', sv);
    const iv = await info(made.video.id);
    check('the video is in the library with its name and type', iv && iv.name === 'clip.webm' && /^video\/webm/.test(iv.type) && iv.size === made.video.size, iv);
    const sVid = await shown(made.video.id, 'video');
    check('the video element loaded its metadata (64 x 48)', sVid.length >= 1 && sVid[0].w === 64 && sVid[0].h === 48 && sVid[0].ready >= 1, sVid);

    // MIDI: the piano is a parts-bin item of a host and there is none here, so the person is told and nothing is kept
    const total0 = (await frame.evaluate(() => window.keo.call('library.fileSearch', { query: '', limit: 1 }, 30000))).total;
    await frame.evaluate(DROP, ['midi', 700, 700]);
    await sleep(3000);
    sv = await frame.evaluate(SURVEY);
    check('a dropped MIDI file: the person is told it cannot be played yet', sv.notes.some((t) => /MIDI files cannot be played/.test(t) && /tune\.mid/.test(t)), sv.notes);
    check('...nothing is added to the library and no morph is made', (await frame.evaluate(() => window.keo.call('library.fileSearch', { query: '', limit: 1 }, 30000))).total === total0 && !sv.refs.some((r) => r.objId === made.midi.id), sv.refs);

    // 100 MB: goes in slice by slice, comes out byte for byte (a player is not asked to decode it)
    const t100 = Date.now();
    await frame.evaluate(DROP, ['huge', 100, 100]);
    let hugeRef = null;
    let sawBar = false;
    for (let i = 0; i < 120 && !hugeRef; i++) {
      await sleep(250);
      if (!sawBar) sawBar = await frame.evaluate(() => { let f = false; $world.withAllSubmorphsDo((m) => { if (/ProgressBar/i.test(String(m.constructor.type || m.constructor.name))) f = true; }); return f; });
      hugeRef = (await frame.evaluate(SURVEY)).refs.find((r) => r.objId === made.huge.id);
    }
    check('a progress bar was on screen while the 100 MB file went in', sawBar === true);
    console.log('INFO 100 MB dropped and shown as a video morph after ' + (Date.now() - t100) + ' ms (includes polling, the page hashing it again and building the player)');
    check('a 100 MB video becomes a video morph', !!hugeRef && /EncryptedVideo/.test(hugeRef.type), hugeRef);
    const ih = await info(made.huge.id);
    check('...stored in 25 slices under its name', ih && ih.chunks === 25 && ih.size === 100 * 1024 * 1024 && ih.name === 'long film.mp4', ih);
    const hugeSame = await frame.evaluate(async (id) => { const b = await new Promise((res, rej) => lively.identity.localFiles.blobFor(id, (e, bl) => e ? rej(e) : res(bl))); return (await window.__d.cid(b)) === id; }, made.huge.id);
    check('...and read back, the 100 MB hash to the name they were stored under', hugeSame === true);

    // sound
    await frame.evaluate(DROP, ['wav', 150, 650]);
    await sleep(3500);
    sv = await frame.evaluate(SURVEY);
    const aud = sv.refs.filter((r) => r.objId === made.wav.id);
    check('a dropped sound file becomes a player morph holding a library reference', aud.length === 1 && /EncryptedAudio/.test(aud[0].type) && aud[0].handle === 'keo:local', sv);
    check('no "unknown type" notice for sound', !sv.notes.some((t) => /unknown type/.test(t)), sv.notes);
    const iw = await info(made.wav.id);
    check('the sound is in the library with its name and type', iw && iw.name === 'sound.wav' && iw.type === 'audio/wav' && iw.size === made.wav.size, iw);
    const sAud = await shown(made.wav.id, 'audio');
    check('the player loaded the sound (one second long)', sAud.length >= 1 && sAud[0].ready >= 1 && Math.abs(sAud[0].dur - 1) < 0.1, sAud);

    // does it really play: press play, time moves on, and the decoded samples carry a signal (measured through the page's own audio graph;
    // what comes out of a speaker is NOT something this test can hear)
    const played = await frame.evaluate(async (id) => {
      const url = lively.identity.localFiles._urls[id];
      const a = Array.from(document.querySelectorAll('audio')).find((e) => e.src === url || e.getAttribute('src') === url);
      if (!a) return { err: 'no audio element' };
      const ac = new AudioContext(), src = ac.createMediaElementSource(a), an = ac.createAnalyser(); an.fftSize = 2048;
      src.connect(an); an.connect(ac.destination);
      let peak = 0, res = {};
      try { await ac.resume(); await a.play(); } catch (e) { return { err: 'play refused: ' + e.message, state: ac.state }; }
      const buf = new Float32Array(an.fftSize), t0 = performance.now();
      while (performance.now() - t0 < 600) { an.getFloatTimeDomainData(buf); for (const v of buf) peak = Math.max(peak, Math.abs(v)); await new Promise((r) => setTimeout(r, 30)); }
      res = { peak: Number(peak.toFixed(3)), currentTime: Number(a.currentTime.toFixed(2)), paused: a.paused, error: a.error && a.error.code, ctx: ac.state };
      a.pause();
      return res;
    }, made.wav.id);
    check('the player plays: time moves on and no error', played.currentTime > 0.3 && played.paused === false && !played.error, played);
    check('...and the decoded samples carry a signal (the 440 Hz tone, peak level above 0.2)', played.peak > 0.2, played);

    // PDF: kept in the library, a morph made, and the viewer (pdf.js, part of the package) draws the page
    await frame.evaluate(DROP, ['pdf', 200, 200]);
    await sleep(3500);
    sv = await frame.evaluate(SURVEY);
    const pdf = sv.refs.filter((r) => r.objId === made.pdf.id);
    check('a dropped PDF becomes a PDF morph holding a library reference', pdf.length === 1 && /EncryptedPDF/.test(pdf[0].type) && pdf[0].handle === 'keo:local', sv);
    const ip = await info(made.pdf.id);
    check('the PDF is in the library with its name and type', ip && ip.name === 'doc.pdf' && ip.type === 'application/pdf' && ip.size === made.pdf.size, ip);
    await sleep(2500);
    const pv = await frame.evaluate(() => {
      const cv = document.querySelector('.kpv-page canvas');
      const spans = Array.from(document.querySelectorAll('.kpv .kpv-info')).map((e) => e.textContent).filter((t) => /Page \d+ of|PDF viewer|Failed to load|Render error/.test(t));
      if (!cv || !cv.width) return { spans, canvas: !!cv };
      const px = cv.getContext('2d').getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
      return { spans, w: cv.width, h: cv.height, px: Array.from(px) };
    });
    check('the PDF viewer ran from the package and says "Page 1 of 1"', pv.spans.includes('Page 1 of 1'), pv);
    check('the page is drawn (a red page, 2:1)', pv.px && pv.px[0] > 200 && pv.px[1] < 60 && pv.px[2] < 60 && Math.abs(pv.w / pv.h - 2) < 0.05, pv);
    check('pdf.js was not fetched from anywhere outside the package', pdfjs.length === 0, pdfjs);

    // several files in one drop: all are stored, one after the other
    await frame.evaluate(DROP, [['p1', 'p2', 'p3', 'p4'], 900, 300]);
    await sleep(6000);
    sv = await frame.evaluate(SURVEY);
    const got = ['p1', 'p2', 'p3', 'p4'].filter((k) => sv.refs.some((r) => r.objId === made[k].id));
    check('four pictures dropped together all arrive', got.length === 4, [got, sv.notes]);
    check('...with no notice of an error', !sv.notes.some((t) => /Too many|Error uploading/.test(t)), sv.notes);

    // a failure half way: what was stored is removed, the person is told, and no picture is made
    const keyCount = () => page.evaluate(() => new Promise((res, rej) => { const q = indexedDB.open('keo-library'); q.onerror = () => rej(q.error); q.onsuccess = () => { const db = q.result, r = db.transaction(['chunks']).objectStore('chunks').count(); r.onsuccess = () => { db.close(); res(r.result); }; }; }));
    const c0 = await keyCount(), t0 = (await frame.evaluate(() => window.keo.call('library.fileSearch', { query: '', limit: 1 }, 30000))).total;
    await frame.evaluate(() => { const orig = window.keo.call; window.__origCall = orig; window.keo.call = function (op, args) { if (op === 'library.fileChunk' && args.n === 1) return Promise.reject(new Error('the disk is full (test)')); return orig.apply(this, arguments); }; });
    await frame.evaluate(DROP, ['big2', 400, 600]);
    await sleep(5000);
    await frame.evaluate(() => { window.keo.call = window.__origCall; });
    sv = await frame.evaluate(SURVEY);
    check('a failure half way: the person is told why', sv.notes.some((t) => /Error uploading/.test(t) && /disk is full/.test(t)), sv.notes);
    check('...no picture is made', !sv.refs.some((r) => r.objId === made.big2.id), sv.refs);
    check('...and nothing stays in the library (no file, no chunk)', (await keyCount()) === c0 && (await frame.evaluate(() => window.keo.call('library.fileSearch', { query: '', limit: 1 }, 30000))).total === t0, [c0, await keyCount()]);

    check('no request left the package ', outside.length === 0, outside);

    // ---- a saved world holds references, not the bytes; and shows the files again, at the size they had, when it is opened
    await frame.evaluate(() => window.keo.call('world.go', { kind: 'blank' }, 120000)).catch(() => {});
    frame = await waitForWorld(page, 'blank');
    made = await frame.evaluate(MAKE);
    const worldExt = await frame.evaluate(() => [Math.round($world.getExtent().x), Math.round($world.getExtent().y)]);
    for (const [k, x, y, wait] of [['big', 60, 60, 6000], ['small', 1000, 60, 3000], ['wav', 60, 700, 3000], ['video', 700, 500, 4000], ['pdf', 1000, 200, 4000]]) {
      await frame.evaluate(DROP, [k, x, y]);
      await sleep(wait);
    }
    await sleep(2000);
    // every morph that holds a reference: id -> [width, height, x, y]
    const SIZES = () => { const o = {}; $world.withAllSubmorphsDo((m) => { if (m.shape && m.shape.fileObjId) o[m.shape.fileObjId] = [Math.round(m.getExtent().x), Math.round(m.getExtent().y), Math.round(m.getPosition().x), Math.round(m.getPosition().y)]; }); return o; };
    sv = await frame.evaluate(SURVEY);
    check('a blank world: the picture, the small picture, the sound, the video and the PDF are in it', sv.refs.length === 5, sv);
    let sz = await frame.evaluate(SIZES);
    const bigSide = sz[made.big.id];
    check('a picture larger than the world is fitted to it, keeping its shape (1500 x 1500 into ' + worldExt.join(' x ') + ')', bigSide && bigSide[0] <= worldExt[0] - 20 && bigSide[1] <= worldExt[1] - 20 && bigSide[0] === bigSide[1] && bigSide[0] > 400, [bigSide, worldExt]);
    check('a picture smaller than the world keeps its own size (40 x 30)', sz[made.small.id] && sz[made.small.id][0] === 40 && sz[made.small.id][1] === 30, sz[made.small.id]);

    // resizing with the resize halo's own drag actions (a real mouse drag does not start a drag in this harness, even for a plain picture):
    // four steps of +30 x +20 must make the box exactly 120 x 80 larger, and must not move it
    const resize = (id) => frame.evaluate(async (id) => {
      const m = (() => { let f = null; $world.withAllSubmorphsDo((x) => { if (x.shape && x.shape.fileObjId === id) f = x; }); return f; })();
      const fake = { isShiftDown: () => false, isAltDown: () => false, getPosition: () => pt(0, 0), isLeftMouseButtonDown: () => true };
      m.removeHalos(); m.showHalos();
      const h = (m.halos || []).find((x) => /ResizeHalo/.test(String(x.constructor.type)));
      const e0 = m.getExtent(), p0 = m.getPosition();
      h.dragStartAction(fake);
      for (let i = 0; i < 4; i++) { h.dragAction(fake, pt(30, 20)); await new Promise((r) => setTimeout(r, 60)); }
      h.dragEndAction(fake);
      await new Promise((r) => setTimeout(r, 300));
      const e1 = m.getExtent(), p1 = m.getPosition(); m.removeHalos();
      return { grew: [Math.round(e1.x - e0.x), Math.round(e1.y - e0.y)], moved: [Math.round(p1.x - p0.x), Math.round(p1.y - p0.y)] };
    }, id);
    for (const [k, what] of [['small', 'picture'], ['video', 'video'], ['wav', 'sound player'], ['pdf', 'PDF']]) {
      const r = await resize(made[k].id);
      check('resizing the ' + what + ': it grows by what was dragged (120 x 80) and does not move', r.grew[0] === 120 && r.grew[1] === 80 && r.moved[0] === 0 && r.moved[1] === 0, r);
    }
    sz = await frame.evaluate(SIZES);                                      // the sizes to be found again after a save

    const saved = await frame.evaluate(() => new Promise((res) => $world.saveWorldAs(URL.root.withFilename('dropworld.html'), false, undefined, (e) => res(e ? { err: e.message } : { ok: true }))));
    check('the world saves', saved.ok === true, saved);
    const list = await frame.evaluate(() => window.keo.call('world.list', {}, 30000));
    const row = list.find((w) => w.name === 'dropworld');
    check('the saved world is small although it shows a ' + Math.round(made.big.size / 1024 / 1024) + ' MB picture (the bytes are not in it)', row && row.bytes < 300000, row);
    await page.reload();
    frame = await waitForWorld(page, 'world');
    sv = await frame.evaluate(SURVEY);
    check('opened again: all five references are back', sv.refs.length === 5 && ['big', 'small', 'wav', 'video', 'pdf'].every((k) => sv.refs.some((r) => r.objId === made[k].id)), sv);
    await sleep(3500);
    const sz2 = await frame.evaluate(SIZES);
    for (const [k, what] of [['big', 'large picture'], ['small', 'resized picture'], ['wav', 'sound player'], ['video', 'resized video'], ['pdf', 'resized PDF']]) {
      const a1 = sz[made[k].id], a2 = sz2[made[k].id];
      check('opened again: the ' + what + ' has the size and place it was saved with', a1 && a2 && a2.every((v, i) => Math.abs(v - a1[i]) <= 1), [a1, a2]);
    }
    const rb = await shown(made.big.id, 'img'), ra = await shown(made.wav.id, 'audio'), rv = await shown(made.video.id, 'video');
    check('opened again: the picture is decoded, the sound loaded and the video loaded again from the library', rb.length >= 1 && rb[0].w === 1500 && ra.length >= 1 && ra[0].ready >= 1 && rv.length >= 1 && rv[0].ready >= 1, [rb, ra, rv]);
    // what is drawn, not only what the morph reports: the page element of each box has the size the morph says
    const drawn = await frame.evaluate((ids) => ids.map((id) => { let f = null; $world.withAllSubmorphsDo((x) => { if (x.shape && x.shape.fileObjId === id) f = x; }); const r = f.renderContext().morphNode.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), Math.round(f.getExtent().x), Math.round(f.getExtent().y)]; }), [made.wav.id, made.video.id, made.pdf.id]);
    check('opened again: the sound player, the video and the PDF are DRAWN at the size they report (not 0 x 0 or 2 x 2)', drawn.every((d) => d[0] > 100 && d[1] > 30 && Math.abs(d[0] - d[2]) <= 2 && Math.abs(d[1] - d[3]) <= 2), drawn);

    check('no request left the package at any point', outside.length === 0, outside);
    console.log('INFO page errors ' + JSON.stringify(errors) + '; console errors ' + JSON.stringify(logs.filter((l) => !/iframe_api|Geolocation|ERR_FILE_NOT_FOUND/.test(l)).slice(0, 6)));
    await page.screenshot({ path: path.join(WORK, 'drop-after.png') });
  } finally { await ctx.close(); }
  console.log(failed ? failed + ' FAILED' : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(1); });
