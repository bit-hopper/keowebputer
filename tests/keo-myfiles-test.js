// "My files" (kernel: lively.identity.MyFilesBrowser) used like a person would, on this device's own library: open it from the identity
// menu, read what each row says, search by real typing, filter by kind, place a file in the world, remove one (answering the question by
// clicking), see a file added anywhere appear without reopening, page through a long list, and see what an empty library says.
// Usage: node keo-myfiles-test.js <repo root> <extension folder> <work dir>
// A headed browser with the extension loaded, `localhost` unresolvable, a virtual authenticator with PRF. The extension has no way to point
// to a file where it lies, so that part of the window (the "Point to a file" button, the "kept on this computer" rows) is exercised by
// keo-desktop's scripts/files-window.js, not here; this test checks that the button is NOT offered here.
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
  if (!frame) throw new Error('the world did not start as ' + kind + (name ? ' ' + name : ''));
  await sleep(2500);
  return frame;
}
const keoCall = (frame, op, args) => frame.evaluate(([o, a]) => window.keo.call(o, a, 60000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [op, args || {}]);
async function until(fn, ms) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > (ms || 12000)) return v; await sleep(250); } }

// ---- reading the window
const readWin = (frame) => frame.evaluate(() => {
  const wins = $world.submorphs.filter((m) => m.name === 'MyFilesBrowser');
  const win = wins[0];
  if (!win) return null;
  const list = win.get('myFilesList');
  const text = (m, n) => { const t = m.submorphs.find((x) => x.name === n); return t ? String(t.textString) : ''; };
  const rows = (list ? list.submorphs : []).filter((m) => m.name === 'fileRow').map((r) => ({ id: r.fileId, name: text(r, 'fileName'), meta: text(r, 'fileMeta'), hasPlace: !!r.submorphs.find((x) => x.name === 'filePlace'), hasMore: !!r.submorphs.find((x) => x.name === 'fileMore') }));
  const status = win.get('myFilesStatus');
  return { windows: wins.length, rows, message: list && list.submorphs.filter((m) => !m.name).map((m) => String(m.textString)).join('|'), status: status ? String(status.textString) : '', query: win.get('searchInput') ? String(win.get('searchInput').textString) : null,
    hasPointBtn: !!win.get('pointBtn'), showMore: (() => { const s = list && list.submorphs.find((m) => m.name === 'fileShowMore'); return s ? String(s.textString) : null; })() };
});
async function rectOf(page, frame, pick, arg) {
  const r = await frame.evaluate(([src, a]) => { const m = (new Function('return (' + src + ')'))()(a); if (!m) return null; const n = m.renderContext().shapeNode; try { n.scrollIntoView({ block: 'nearest' }); } catch (e) {} const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, [pick.toString(), arg === undefined ? null : arg]);
  if (!r) return null;
  const off = await (await frame.frameElement()).boundingBox();
  return { x: off.x + r.x, y: off.y + r.y, w: r.w, h: r.h };
}
const byName = (page, frame, name) => rectOf(page, frame, (n) => { const w = $world.submorphs.find((m) => m.name === 'MyFilesBrowser'); return w && w.get(n); }, name);
const rowPart = (page, frame, id, part) => rectOf(page, frame, ([i, p]) => { const win = $world.submorphs.find((m) => m.name === 'MyFilesBrowser'); const r = win && win.get('myFilesList') && win.get('myFilesList').submorphs.find((m) => m.name === 'fileRow' && m.fileId === i); return r && r.submorphs.find((x) => x.name === p); }, [id, part]);
const textRect = (page, frame, s) => rectOf(page, frame, (str) => { let hit = null; (function walk(m) { if (hit) return; if (typeof m.textString === 'string' && m.textString.trim() === str && m.renderContext && m.renderContext().shapeNode && m.renderContext().shapeNode.getBoundingClientRect().width > 0) hit = m; (m.submorphs || []).forEach(walk); })($world); return hit; }, s);
const hasText = (frame, src) => frame.evaluate((s) => { const re = new RegExp(s); let hit = false; (function walk(m) { if (hit) return; if (typeof m.textString === 'string' && re.test(m.textString)) hit = true; (m.submorphs || []).forEach(walk); })($world); return hit; }, src);
const click = async (page, r) => { await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2); };
const okRect = (page, frame) => rectOf(page, frame, () => { let found = null; (function walk(m) { if (found) return; if (m instanceof lively.morphic.Button && /^(OK|Yes)$/i.test(String(m.getLabel ? m.getLabel() : ''))) found = m; (m.submorphs || []).forEach(walk); })($world); return found; });
const names = (rows) => rows.map((r) => r.name);

// A file made in the library through the shell, as a drop makes one (name, type, bytes).
const addFile = (page, name, type, size, seed) => page.evaluate(async ([n, t, s, d]) => {
  const L = window.keoLibrary, bytes = new Uint8Array(s); for (let i = 0; i < s; i++) bytes[i] = (i * 31 + d) & 255;
  const b = await L.fileBegin({ name: n, type: t, size: s });
  await L.fileChunk({ upload: b.upload, n: 0, bytes });
  return (await L.fileEnd({ upload: b.upload })).id;
}, [name, type, size, seed]);

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-myfiles'), {
    headless: false, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });

    await page.goto(`chrome-extension://${ID}/start.html`);
    let frame = await waitForWorld(page, 'gate');
    await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }));
    await keoCall(frame, 'world.go', { kind: 'enter' }).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    await keoCall(frame, 'world.go', { kind: 'blank', name: 'Files room' }).catch(() => {});
    frame = await waitForWorld(page, 'blank', 'Files room');

    // ---- four files, added one after another so their order is known (newest first in the list)
    const ids = {};
    ids.sunset = await addFile(page, 'sunset.png', 'image/png', 3000, 1); await sleep(40);
    ids.tone = await addFile(page, 'tone.wav', 'audio/wav', 5000, 2); await sleep(40);
    ids.notes = await addFile(page, 'Meeting notes.pdf', 'application/pdf', 70000, 3); await sleep(40);
    ids.film = await addFile(page, 'film.mp4', 'video/mp4', 2 * 1048576 + 17, 4);

    // ---- the identity menu offers it, next to My worlds, and asking twice opens one window
    const items = await frame.evaluate(() => { const e = $world.get('IdentityMenuBarEntry'); return e ? e.morphMenuItems().map((i) => i[0]) : null; });
    check('menu: "My files" is offered right after "My worlds"', items && items.indexOf('My files') === items.indexOf('My worlds') + 1, items);
    await frame.evaluate(() => { const e = $world.get('IdentityMenuBarEntry'); const it = e.morphMenuItems().find((i) => i[0] === 'My files'); it[1](); });
    let win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 4 ? s : null; });
    check('window: it opens and lists the four files, newest first', win && names(win.rows).join() === 'film.mp4,Meeting notes.pdf,tone.wav,sunset.png', win);
    await frame.evaluate(() => { const e = $world.get('IdentityMenuBarEntry'); e.morphMenuItems().find((i) => i[0] === 'My files')[1](); });
    await sleep(1200);
    check('window: asking again leaves one window', (await readWin(frame)).windows === 1);
    check('window: each row says its kind, its size and when it was added; every row has "place" and the "⋯" menu',
      win && win.rows.every((r) => r.hasPlace && r.hasMore && /added (just now|\d+ min ago)/.test(r.meta)) && /^Video {2}· {2}2 MB {2}· {2}added /.test(win.rows[0].meta) && /^PDF {2}· {2}68\.4 KB {2}· {2}added /.test(win.rows[1].meta) && /^Sound {2}· {2}4\.9 KB {2}· {2}added /.test(win.rows[2].meta) && /^Picture {2}· {2}2\.9 KB {2}· {2}added /.test(win.rows[3].meta), win && win.rows.map((r) => r.meta));
    check('window: in the extension no row says it is kept on this computer, and there is no "Point to a file" button (it cannot read a file where it lies)', !win.hasPointBtn && win.rows.every((r) => !/kept on this computer/.test(r.meta)), win);
    check('window: the line under the list says what the files take and how much room is left', !!(await until(async () => { const s = await readWin(frame); return s && /^Files 2\.1 MB · room for about [\d.]+ [GT]B more$/.test(s.status); })), await readWin(frame));

    // A picture of the window, for a person to look at (the look of the rows and icons is not something a check can judge).
    try { await page.screenshot({ path: path.join(WORK, 'myfiles-list.png') }); } catch (e) { /* not essential */ }
    // ---- search by real typing; filter by kind
    let r = await byName(page, frame, 'searchInput'); await click(page, r);
    await page.keyboard.type('TONE');
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 1 ? s : null; });
    check('search: typing "TONE" leaves the one file with that word in its name, whatever the case', win && names(win.rows).join() === 'tone.wav', win);
    await page.keyboard.press('Control+A'); await page.keyboard.type('notes pdf');
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 1 && s.rows[0].name === 'Meeting notes.pdf' ? s : null; });
    check('search: words may be in any part of the name ("notes pdf")', !!win, await readWin(frame));
    await page.keyboard.press('Control+A'); await page.keyboard.type('zebra');
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 0 && /No file matches/.test(s.message || '') ? s : null; });
    check('search: nothing found says so', !!win, await readWin(frame));
    await page.keyboard.press('Control+A'); await page.keyboard.press('Delete');
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 4 ? s : null; });
    check('search: clearing the field lists everything again', !!win, await readWin(frame));
    r = await byName(page, frame, 'kind_audio/'); await click(page, r);
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 1 ? s : null; });
    check('filter: "Sound" lists only sound', win && names(win.rows).join() === 'tone.wav', win);
    r = await byName(page, frame, 'kind_image/'); await click(page, r);
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 1 && s.rows[0].name === 'sunset.png' ? s : null; });
    check('filter: "Pictures" lists only pictures', !!win, await readWin(frame));
    r = await byName(page, frame, 'kind_all'); await click(page, r);
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 4 ? s : null; });
    check('filter: "All" lists everything again', !!win, await readWin(frame));

    // ---- place a file in the world
    r = await rowPart(page, frame, ids.sunset, 'filePlace'); await click(page, r);
    const placed = await until(() => frame.evaluate((id) => { let hit = null; $world.withAllSubmorphsDo((m) => { if (m.shape && m.shape.fileObjId === id && m.shape.fileHandle === 'keo:local') hit = m.constructor.type; }); return hit; }, ids.sunset), 15000);
    check('place: "place" puts the picture in the world as a dropped picture would be shown', placed === 'lively.data.FileUpload.EncryptedImage', placed);
    check('place: the line under the list says so', !!(await until(async () => { const s = await readWin(frame); return s && /^Placed “sunset\.png” in the world\.$/.test(s.status); })), (await readWin(frame)).status);
    r = await rowPart(page, frame, ids.tone, 'filePlace'); await click(page, r);
    const placed2 = await until(() => frame.evaluate((id) => { let hit = null, pos = []; $world.withAllSubmorphsDo((m) => { if (m.shape && m.shape.fileObjId === id) { hit = m.constructor.type; } }); return hit; }, ids.tone), 15000);
    check('place: a sound is placed as a player', placed2 === 'lively.data.FileUpload.EncryptedAudio', placed2);
    const apart = await frame.evaluate((a) => { const f = (id) => { let p = null; $world.withAllSubmorphsDo((m) => { if (m.shape && m.shape.fileObjId === id) p = m.getPosition(); }); return p; }; const p1 = f(a[0]), p2 = f(a[1]); return p1 && p2 ? [Math.round(p2.x - p1.x), Math.round(p2.y - p1.y)] : null; }, [ids.sunset, ids.tone]);
    check('place: the second file lands a little lower and to the right of the first, so they do not hide each other', apart && apart[0] === 30 && apart[1] === 30, apart);

    // ---- the row menu, and removing a file (the question is answered by clicking)
    r = await rowPart(page, frame, ids.tone, 'fileMore'); await click(page, r);
    await until(() => textRect(page, frame, 'Remove from library …'), 5000);
    const menu = { place: !!(await textRect(page, frame, 'Place in world')), remove: !!(await textRect(page, frame, 'Remove from library …')), again: !!(await textRect(page, frame, 'Point to it again …')), stop: !!(await textRect(page, frame, 'Stop using this file …')) };
    check('row menu: a copy offers "Place in world" and "Remove from library …" and nothing about pointing', menu.place && menu.remove && !menu.again && !menu.stop, menu);
    await click(page, await textRect(page, frame, 'Remove from library …'));
    check('remove: it asks first, and says worlds that show the file will not be able to, and that it cannot be undone', !!(await until(() => hasText(frame, 'Worlds that show it will not be able to show it any more\\. This cannot be undone'), 6000)) && (await keoCall(frame, 'library.fileInfo', { id: ids.tone })).r !== null);
    const ok = await okRect(page, frame);
    check('remove: the question has a button to confirm', !!ok);
    if (ok) await click(page, ok);
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 3 ? s : null; });
    check('remove: the row is gone, the library has no such file, and the line says so', win && !names(win.rows).includes('tone.wav') && (await keoCall(frame, 'library.fileInfo', { id: ids.tone })).r === null && /^Removed “tone\.wav”\.$/.test(win.status), win);

    // ---- a file added anywhere shows up without reopening (a drop goes through the same call)
    await frame.evaluate(() => new Promise((res) => { const f = new File([new Uint8Array(1234).fill(9)], 'late.gif', { type: 'image/gif' }); lively.identity.localFiles.put(f, {}, () => res()); }));
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 4 && s.rows[0].name === 'late.gif' ? s : null; });
    check('live: a file added while the window is open appears at the top', !!win, await readWin(frame));

    // ---- a long list is paged
    await frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'MyFilesBrowser'); w.PAGE = 3; w._shown = 3; w.load(); });
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 3 && s.showMore ? s : null; });
    check('paging: with more files than fit a page, the list ends with "Show more (n more)"', win && win.showMore === 'Show more (1 more)', win && win.showMore);
    r = await byName(page, frame, null) || null;
    const sm = await rectOf(page, frame, () => { const w = $world.submorphs.find((m) => m.name === 'MyFilesBrowser'); return w.get('myFilesList').submorphs.find((m) => m.name === 'fileShowMore'); });
    if (sm) await click(page, sm);
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 4 && !s.showMore ? s : null; });
    check('paging: "Show more" lists the rest', !!win, await readWin(frame));

    // ---- an empty library says what to do
    for (const id of Object.values(ids)) await keoCall(frame, 'library.fileRemove', { id });
    const all = (await keoCall(frame, 'library.fileSearch', { query: '', limit: 200 })).r;
    for (const it of all.items) await keoCall(frame, 'library.fileRemove', { id: it.id });
    await frame.evaluate(() => lively.identity.localFiles.changed());
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 0 && /No files yet/.test(s.message || '') ? s : null; });
    check('empty: with no files the list says to drop one onto a world (and, in the extension, does not mention pointing)', win && /^No files yet\. Drop a picture, video, sound or PDF onto a world\.$/.test(win.message), win);

    check('no page errors', errors.length === 0, errors);
  } catch (e) {
    check('the run finished without an exception', false, String(e && e.stack || e));
  }
  await ctx.close();
  console.log(failed ? 'FAILED: ' + failed : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
