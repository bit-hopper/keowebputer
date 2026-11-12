// Small pictures for REAL files, named on the command line (a video, a PDF, a book): each file is put into the library, the small
// picture the world makes is read back and saved as a JPEG in the work dir, and for each file the run says whether one was made, its
// size, how long it took, and how much memory the browser used while the older-file path (the whole file read back out of the library,
// which is what a file added before small pictures existed goes through) made it. It checks nothing about the picture's content: look at
// the saved pictures. Only the files named are read; nothing is searched for. The files are YOURS to choose: never point this at a
// person's own files; use files made or downloaded into a temporary folder.
// The browser memory is the sum of the working sets of the browser processes started with this run's own profile folder (found by that
// unique folder name; nothing is stopped).
// Usage: node keo-thumbs-files-test.js <repo root> <extension folder> <work dir> [--browser <program>] <file> [<file> ...]
//   --browser  the program of an installed browser (its full path) instead of the test browser, to try codecs and builds the test browser
//              lacks. It is started with extension debugging on and the package is loaded through the debugging protocol (a branded
//              browser ignores --load-extension).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const rest = process.argv.slice(5);
const bi = rest.indexOf('--browser');
const BROWSER = bi >= 0 ? rest[bi + 1] : null;
if (bi >= 0 && (!BROWSER || !fs.existsSync(BROWSER))) { console.error('--browser needs the full path of an installed browser program'); process.exit(2); }
const FILES = rest.filter((a, i) => bi < 0 || (i !== bi && i !== bi + 1)).map((f) => path.resolve(f));
if (!FILES.length) { console.error('name at least one file'); process.exit(2); }
for (const f of FILES) if (!fs.existsSync(f)) { console.error('no such file: ' + f); process.exit(2); }
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = 1024 * 1024;
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

const TAG = 'profile-thumbsfiles-' + Date.now();
// MB of working set of the browser processes of THIS run (their command line holds the unique profile folder name)
function browserMB() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" + TAG + "*' } | Measure-Object -Property WorkingSetSize -Sum).Sum"], { encoding: 'utf8', timeout: 20000 });
    return Math.round(Number(out.trim()) / MB);
  } catch (e) { return null; }
}

(async () => {
  const args = [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'];
  let ctx, child = null;
  if (BROWSER) {
    // A branded browser ignores --load-extension, so it is started here with extension debugging on and the package is loaded through
    // the debugging protocol. Only the process started here is stopped (its PID, and the processes under it).
    const port = 9400 + Math.floor(Math.random() * 400);
    const exe = BROWSER;
    child = require('child_process').spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(WORK, TAG)}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
      '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND', 'about:blank'], { stdio: 'ignore' });
    let browser = null;
    for (let i = 0; i < 40 && !browser; i++) { await sleep(500); try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); } catch (e) {} }
    if (!browser) { try { child.kill(); } catch (e) {} throw new Error('the installed browser did not answer on its debugging port'); }
    const bs = await browser.newBrowserCDPSession();
    const loaded = await bs.send('Extensions.loadUnpacked', { path: EXT });
    console.log('extension loaded in the installed browser: ' + JSON.stringify(loaded));
    ctx = browser.contexts()[0];
    ctx.close = async () => { try { await browser.close(); } catch (e) {} try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} };
  } else {
    ctx = await chromium.launchPersistentContext(path.join(WORK, TAG), { headless: false, viewport: { width: 1280, height: 900 }, args });
  }
  await sleep(2500);
  let failed = 0;
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
    await keoCall(frame, 'world.go', { kind: 'blank', name: 'Real files room' }).catch(() => {});
    frame = await waitForWorld(page, 'blank', 'Real files room');
    console.log('browser: ' + (await page.evaluate(() => navigator.userAgent)) + (BROWSER ? '  (installed)' : '  (test browser)'));
    const can = await frame.evaluate(() => { const v = document.createElement('video'); return { h264: v.canPlayType('video/mp4; codecs="avc1.64001f"'), hevc: v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'), vp9: v.canPlayType('video/webm; codecs="vp9"'), webm: v.canPlayType('video/webm') }; });
    console.log('this browser can play: ' + JSON.stringify(can));
    await frame.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = '__in'; document.body.appendChild(i); });
    for (const file of FILES) {
      const name = path.basename(file), size = fs.statSync(file).size;
      console.log('\n== ' + name + '  (' + (size / MB).toFixed(1) + ' MB)');
      await frame.setInputFiles('#__in', file);
      const base = browserMB();
      // The memory is sampled from BEFORE the file is added until its small picture exists, so it covers the transfer and the drawing at add time
      // (each sample takes about a second, so a short peak can be missed: the numbers are a floor, not an exact peak).
      let peak = 0, stop = false;
      const sampler = (async () => { while (!stop) { const m = browserMB(); if (m && m > peak) peak = m; await sleep(300); } })();
      const t0 = Date.now();
      const put = await frame.evaluate(() => new Promise((res) => { const f = document.getElementById('__in').files[0]; window.__lastFile = f; lively.identity.localFiles.put(f, {}, (e, r) => res(e ? { err: e.message } : { id: r.id, type: r.type, existed: r.existed })); }));
      if (put.err) { stop = true; await sampler; console.log('  put failed: ' + put.err); failed++; continue; }
      console.log('  kept in the library as ' + put.type + (put.existed ? ' (it was there already)' : '') + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
      const kind = await frame.evaluate(([t, s]) => lively.identity.localFiles.previewKind(t, s), [put.type, size]);
      console.log('  kind with a small picture: ' + kind);
      // made at add time, from the file at hand
      const t1 = Date.now();
      const got = await until(async () => { const r = await keoCall(frame, 'library.thumbGet', { ids: [put.id] }); return r.ok && r.r[put.id] ? true : null; }, kind ? 70000 : 6000);
      const tAdd = Date.now() - t1;
      stop = true; await sampler;
      console.log('  at add time: ' + (got ? 'small picture made' : (kind ? 'NONE made' : 'none (no small picture for this kind)')) + (got ? ' in ' + (tAdd / 1000).toFixed(1) + ' s' : '') + '; browser memory before ' + base + ' MB, peak ' + peak + ' MB');
      if (kind && !got) failed++;
      if (kind === 'pdf' && !got) {
        // say WHY the PDF reader gave up (a password, a damaged file, ...) instead of guessing
        const why = await frame.evaluate(() => new Promise((res) => lively.identity.localFiles._withPdfjs((err, lib) => {
          if (err) return res('reader not loaded: ' + err.message);
          window.__lastFile.arrayBuffer().then((b) => lib.getDocument({ data: new Uint8Array(b) }).promise.then(() => res('opened without a password'), (e) => res(String(e && e.name) + ': ' + String(e && e.message))));
        })));
        console.log('  the PDF reader says: ' + why);
      }
      const save = async (tag) => {
        const r = await keoCall(frame, 'library.thumbGet', { ids: [put.id] });
        if (!r.ok || !r.r[put.id]) return null;
        const b = await frame.evaluate(async (id) => { const r = await window.keo.call('library.thumbGet', { ids: [id] }, 30000); const bm = await createImageBitmap(new Blob([r[id]], { type: 'image/jpeg' })); return { w: bm.width, h: bm.height, n: r[id].byteLength }; }, put.id);
        const bytes = await frame.evaluate(async (id) => { const r = await window.keo.call('library.thumbGet', { ids: [id] }, 30000); let s = ''; const u = new Uint8Array(r[id]); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); }, put.id);
        const out = path.join(WORK, name.replace(/[^A-Za-z0-9._-]/g, '_') + tag + '.jpg');
        fs.writeFileSync(out, Buffer.from(bytes, 'base64'));
        return { out, w: b.w, h: b.h, n: b.n };
      };
      const s1 = await save('.add');
      if (s1) console.log('  saved ' + s1.w + ' x ' + s1.h + ', ' + s1.n + ' bytes: ' + s1.out);
      // the older-file path: the whole file is read back out of the library, then drawn (what a file added before small pictures existed goes through)
      if (kind) {
        await frame.evaluate((id) => { const lf = lively.identity.localFiles; delete lf._thumbUrls[id]; delete lf._thumbFail[id]; }, put.id);
        const base2 = browserMB();
        let peak2 = 0, stop2 = false;
        const samp2 = (async () => { while (!stop2) { const m = browserMB(); if (m && m > peak2) peak2 = m; await sleep(300); } })();
        const t2 = Date.now();
        const again = await frame.evaluate(([id, k]) => new Promise((res) => {
          const lf = lively.identity.localFiles; let n = 0;
          const h = (e) => { if (e.detail.id === id) { window.removeEventListener('keo-thumb', h); res({ ok: true }); } };
          window.addEventListener('keo-thumb', h);
          lf._thumbPending[id] = true; lf._thumbQ.push({ id, source: null, kind: k }); lf._pumpThumbs();
          const tm = setInterval(() => { n++; if (lf._thumbFail[id]) { clearInterval(tm); window.removeEventListener('keo-thumb', h); res({ ok: false, why: 'gave up' }); } if (n > 400) { clearInterval(tm); res({ ok: false, why: 'too slow' }); } }, 250);
        }), [put.id, kind]);
        stop2 = true; await samp2;
        console.log('  older-file path (read back whole from the library): ' + (again.ok ? 'small picture made' : 'NONE (' + again.why + ')') + ' in ' + ((Date.now() - t2) / 1000).toFixed(1) + ' s; browser memory before ' + base2 + ' MB, peak ' + peak2 + ' MB, after ' + browserMB() + ' MB');
        if (!again.ok) failed++;
        await sleep(1500);
        console.log('  after a pause: browser memory ' + browserMB() + ' MB');
      }
      await frame.evaluate((id) => new Promise((res) => lively.identity.localFiles.remove(id, res)), put.id);
    }
    if (errors.length) console.log('\npage errors: ' + JSON.stringify(errors));
  } catch (e) {
    console.log('FAIL the run finished with an exception: ' + String(e && e.stack || e));
    failed++;
  }
  await ctx.close();
  console.log('\n' + (failed ? 'DONE with ' + failed + ' file(s) with no small picture where one was expected (or an error)' : 'DONE: every file of a kind that has a small picture got one'));
  process.exit(failed ? 1 : 0);
})();
