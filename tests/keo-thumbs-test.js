// Small pictures (thumbnails) and the grid in the My files window (shell: library.thumbPut / thumbGet; kernel: lively.identity.LocalFiles
// ensureThumbs / thumbSoon, lively.identity.MyFilesBrowser). Checks: a picture added to the library gets a small JPEG at once (longest
// side 200, never enlarged, a transparent picture on white) and only a picture does; a file that cannot be decoded gets none and is not
// tried again; a picture added before small pictures existed gets one the first time a list shows it; the list shows them in place of
// the icon, the grid switch (a real click) turns the list into tiles that show them, selecting and the card menu still work in the grid;
// a window opened again in a new session reads them from the shell instead of drawing them again; removing a file removes its small
// picture. Real PNGs are made in the page; the clicks are real.
// Usage: node keo-thumbs-test.js <repo root> <extension folder> <work dir>
const fs = require('fs');
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

// the rows or tiles of the open window: name, whether a small picture is drawn (and its size), the icon otherwise
const READ = () => {
  const root = document.querySelector('.mf-root');
  if (!root) return null;
  const list = root.querySelector('.mf-list');
  return { grid: list.classList.contains('mf-grid'), cols: getComputedStyle(list).gridTemplateColumns.split(' ').filter(Boolean).length,
    pressed: [...root.querySelectorAll('.mf-seg button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.view).join(),
    items: [...root.querySelectorAll('.mf-row')].map((r) => { const im = r.querySelector('img'); const ic = r.querySelector('.mf-ms:not(.mf-chk .mf-ms)');
      return { id: r.dataset.id, name: (r.querySelector('.mf-nmx') || {}).title, tile: r.classList.contains('mf-tile'), sel: r.classList.contains('sel'), img: im ? [im.naturalWidth, im.naturalHeight, im.complete] : null, icon: !im && ic ? ic.innerText : null }; }),
    prevName: ((root.querySelector('.mf-prev .mf-t') || {}).innerText || '').trim(), status: ((root.querySelector('.mf-status span') || {}).innerText || '').trim(),
    popItems: [...root.querySelectorAll('.mf-pop .mf-it')].map((i) => i.innerText.replace(/\s+/g, ' ').trim()) };
};

const OPEN = () => new Promise((res) => lively.require('lively.identity.MyFilesBrowser').toRun(() => { lively.identity.MyFilesBrowser.open(); res(); }));

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-thumbs-' + Date.now()), {
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
    await keoCall(frame, 'world.go', { kind: 'blank', name: 'Pictures room' }).catch(() => {});
    frame = await waitForWorld(page, 'blank', 'Pictures room');

    // ---- files, made in the page: real PNGs, a file that is not a picture although it says so, and two that are no pictures
    const made = await frame.evaluate(async () => {
      const png = (w, h, draw) => new Promise((r) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); draw(g, w, h); c.toBlob(r, 'image/png'); });
      const d = window.__d = {};
      d.red = new File([await png(600, 400, (g, w, h) => { g.fillStyle = '#c8285a'; g.fillRect(0, 0, w, h); })], 'red.png', { type: 'image/png' });
      d.tall = new File([await png(100, 400, (g, w, h) => { g.fillStyle = '#2563eb'; g.fillRect(0, 0, w, h); })], 'tall.png', { type: 'image/png' });
      d.clear = new File([await png(300, 300, () => {})], 'clear.png', { type: 'image/png' });
      d.small = new File([await png(40, 30, (g, w, h) => { g.fillStyle = '#2f9e5b'; g.fillRect(0, 0, w, h); })], 'small.png', { type: 'image/png' });
      d.broken = new File([new Uint8Array(3000).map((_, i) => (i * 31 + 7) & 255)], 'broken.png', { type: 'image/png' });
      d.note = new File([new TextEncoder().encode('just words')], 'words.txt', { type: 'text/plain' });
      d.old = await png(500, 500, (g, w, h) => { g.fillStyle = '#e8a317'; g.fillRect(0, 0, w, h); });
      const out = {};
      for (const k of ['red', 'tall', 'clear', 'small', 'broken', 'note']) {
        out[k] = await new Promise((res) => lively.identity.localFiles.put(d[k], {}, (e, r) => res(e ? { err: e.message } : r.id)));
      }
      return out;
    });
    check('setup: six files went into the library', Object.values(made).every((v) => typeof v === 'string'), made);
    // an older picture: put into the library through the shell directly, as files were before small pictures existed (no world, no small picture made)
    made.old = await frame.evaluate(async () => {
      const bytes = new Uint8Array(await window.__d.old.arrayBuffer()), L = window.keo;
      const b = await L.call('library.fileBegin', { name: 'old.png', type: 'image/png', size: bytes.length }, 30000);
      await L.call('library.fileChunk', { upload: b.upload, n: 0, bytes: bytes.buffer.slice(0) }, 30000);
      return (await L.call('library.fileEnd', { upload: b.upload }, 30000)).id;
    });

    // ---- made when the picture was added (no window open): only for pictures that can be drawn
    const ids = ['red', 'tall', 'clear', 'small'].map((k) => made[k]);
    const have = await until(async () => { const r = await keoCall(frame, 'library.thumbGet', { ids: ids.concat([made.broken, made.note, made.old]) }); return r.ok && Object.keys(r.r).length >= 4 ? r.r : null; }, 20000);
    check('four small pictures were made when the pictures were added, with no window open', !!have && ids.every((i) => have[i]), have && Object.keys(have));
    check('none for a file that cannot be drawn, none for a text file, none yet for the older picture', !!have && !have[made.broken] && !have[made.note] && !have[made.old], have && Object.keys(have));
    const dims = await frame.evaluate(async (all) => {
      const r = await window.keo.call('library.thumbGet', { ids: all }, 30000), out = {};
      for (const id of Object.keys(r)) { const bm = await createImageBitmap(new Blob([r[id]], { type: 'image/jpeg' })); const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; const g = c.getContext('2d'); g.drawImage(bm, 0, 0); out[id] = { w: bm.width, h: bm.height, px: Array.from(g.getImageData(1, 1, 1, 1).data), bytes: r[id].byteLength }; }
      return out;
    }, ids);
    check('a 600 x 400 picture is 200 x 133, a 100 x 400 one 50 x 200, a 40 x 30 one stays 40 x 30 (never enlarged)', dims[made.red].w === 200 && dims[made.red].h === 133 && dims[made.tall].w === 50 && dims[made.tall].h === 200 && dims[made.small].w === 40 && dims[made.small].h === 30, dims);
    check('a transparent picture is drawn on white (not black)', dims[made.clear].px[0] > 240 && dims[made.clear].px[1] > 240 && dims[made.clear].px[2] > 240, dims[made.clear]);
    check('every small picture is small (under 20 KB here)', Object.values(dims).every((d) => d.bytes < 20 * 1024), Object.values(dims).map((d) => d.bytes));
    check('the colour is kept (the red picture\'s corner is red)', dims[made.red].px[0] > 150 && dims[made.red].px[1] < 90, dims[made.red].px);

    // ---- the window, list view: small pictures in place of the icons, the older picture gets its own when it is shown
    await frame.evaluate(() => { window.__draws = 0; const lf = lively.identity.localFiles, orig = lf._drawThumb; lf._drawThumb = function () { window.__draws++; return orig.apply(this, arguments); }; });
    await frame.evaluate(OPEN);
    let win = await until(async () => { const w = await frame.evaluate(READ); return w && w.items.length === 7 && w.items.filter((i) => i.img).length === 5 ? w : null; }, 25000);
    check('the list shows a small picture for each of the five pictures that can be drawn (the older one included)', !!win, await frame.evaluate(READ));
    const byName = (w, n) => w.items.find((i) => i.name === n);
    check('the file that cannot be drawn and the text file keep their icons', !!win && !byName(win, 'broken.png').img && byName(win, 'broken.png').icon === 'image' && !byName(win, 'words.txt').img, win && win.items.filter((i) => !i.img));
    check('each small picture is really drawn (it has a size and is loaded)', !!win && win.items.filter((i) => i.img).every((i) => i.img[2] && i.img[0] > 0 && i.img[1] > 0 && Math.max(i.img[0], i.img[1]) <= 200), win && win.items.map((i) => i.img));
    const draws1 = await frame.evaluate(() => window.__draws);
    check('only the older picture had to be made when the list was shown (the others were made already; the broken one is not tried again)', draws1 === 1, draws1);
    const nThumbs = (await keoCall(frame, 'library.thumbGet', { ids: Object.values(made) })).r;
    check('and now the shell holds five small pictures', Object.keys(nThumbs).length === 5 && !!nThumbs[made.old], Object.keys(nThumbs).length);
    await page.screenshot({ path: path.join(WORK, 'thumbs-list.png') });

    // ---- the grid (a real click on the switch)
    await click(frame, R('.mf-seg button[data-view=grid]'));
    win = await until(async () => { const w = await frame.evaluate(READ); return w && w.grid ? w : null; });
    check('the grid switch turns the list into tiles: seven tiles, the switch says grid, and there are columns', !!win && win.pressed === 'grid' && win.items.length === 7 && win.items.every((i) => i.tile) && win.cols >= 2, win && [win.pressed, win.cols, win.items.length]);
    check('the tiles show the small pictures too, and the others an icon (a text file wears the document sign)', !!win && win.items.filter((i) => i.img).length === 5 && win.items.filter((i) => i.img).every((i) => i.img[0] > 0) && byName(win, 'words.txt').icon === 'picture_as_pdf', win && win.items);
    await frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'MyFilesBrowser'); w.comeForward(); });
    await page.screenshot({ path: path.join(WORK, 'thumbs-grid.png') });
    const tileSel = (n) => R('.mf-row[data-id="' + made[n] + '"] .mf-th');
    await click(frame, tileSel('red'));
    win = await until(async () => { const w = await frame.evaluate(READ); return w && w.prevName === 'red.png' ? w : null; });
    check('a click on a tile chooses it and the preview shows it', !!win && byName(win, 'red.png').sel && win.prevName === 'red.png', win && [win.prevName]);
    await click(frame, tileSel('tall'), { modifiers: ['Control'] });
    win = await until(async () => { const w = await frame.evaluate(READ); return w && w.items.filter((i) => i.sel).length === 2 ? w : null; });
    check('Ctrl-click adds a second tile to the choice', !!win && byName(win, 'red.png').sel && byName(win, 'tall.png').sel, win && win.items.map((i) => i.sel));
    await click(frame, tileSel('small'));
    await click(frame, R('.mf-row[data-id="' + made.small + '"] [data-act=more]'), { force: true });
    win = await until(async () => { const w = await frame.evaluate(READ); return w && w.popItems.length ? w : null; });
    check('a tile\'s ... button opens the same card menu (Save a copy included)', !!win && win.popItems.join('|') === 'Place in world|Rename …|Save a copy to this computer|Move to …|Remove from library …', win && win.popItems);
    await page.keyboard.press('Escape');
    await click(frame, tileSel('small'));
    await click(frame, tileSel('tall'), { modifiers: ['Shift'] });
    win = await until(async () => { const w = await frame.evaluate(READ); return w && w.items.filter((i) => i.sel).length === 3 ? w : null; });
    check('Shift-click chooses everything between two tiles (small, clear and tall)', !!win && ['small.png', 'clear.png', 'tall.png'].every((n) => byName(win, n).sel), win && win.items.map((i) => i.name + ':' + i.sel));
    // the view survives the list being read again
    await frame.evaluate(() => lively.identity.localFiles.changed());
    await sleep(800);
    win = await frame.evaluate(READ);
    check('the grid stays a grid when the library changes', !!win && win.grid && win.pressed === 'grid', win && [win.grid, win.pressed]);
    await click(frame, R('.mf-seg button[data-view=list]'));
    win = await until(async () => { const w = await frame.evaluate(READ); return w && !w.grid ? w : null; });
    check('the list switch goes back to rows, still with their small pictures', !!win && win.pressed === 'list' && win.items.every((i) => !i.tile) && win.items.filter((i) => i.img).length === 5, win && [win.pressed, win.items.filter((i) => i.img).length]);

    // ---- a window opened in a new session: the small pictures come from the shell, none is drawn again
    await frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'MyFilesBrowser'); w.remove(); const lf = lively.identity.localFiles; lf._thumbUrls = {}; lf._thumbFail = {}; lf._thumbPending = {}; lf._thumbQ = []; window.__draws = 0; });
    await frame.evaluate(OPEN);
    win = await until(async () => { const w = await frame.evaluate(READ); return w && w.items.length === 7 && w.items.filter((i) => i.img).length === 5 ? w : null; }, 20000);
    const draws2 = await frame.evaluate(() => window.__draws);
    check('opened again with nothing remembered by the page: the five small pictures are read from the shell and only the broken file is tried once more (nothing that has a small picture is drawn again)', !!win && draws2 === 1, [draws2, win && win.items.filter((i) => i.img).length]);

    // ---- removing a file removes its small picture
    const before = Object.keys((await keoCall(frame, 'library.thumbGet', { ids: Object.values(made) })).r).length;
    await frame.evaluate((id) => new Promise((res) => lively.identity.localFiles.remove(id, res)), made.red);
    const after = Object.keys((await keoCall(frame, 'library.thumbGet', { ids: Object.values(made) })).r).length;
    check('removing a picture removes its small picture', before === 5 && after === 4, [before, after]);
    check('the window\'s list follows: six files, the removed one gone', !!(await until(async () => { const w = await frame.evaluate(READ); return w && w.items.length === 6 && !byName(w, 'red.png') ? w : null; })));

    check('no request left the package', outside.length === 0, outside);
    check('no page errors', errors.length === 0, errors);
  } catch (e) {
    check('the run finished without an exception', false, String(e && e.stack || e));
  }
  await ctx.close();
  console.log(failed ? 'FAILED: ' + failed : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
