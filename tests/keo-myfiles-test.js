// "My files" (kernel: lively.identity.MyFilesBrowser) used like a person would, on this device's own library: open it from the identity
// menu, read the cards, search by real typing, filter by kind, sort, pick one file or several (click, Ctrl, Shift, the tick box, the
// keys), the preview panel, rename (double-click, F2, the pencil; Enter, Esc, a name that is refused, Undo), make, rename and delete
// folders, move files (the Move to menu, the strip, a real drag onto a folder, Undo), place files in the world, remove one or several
// (answering the question by clicking), see a file added anywhere appear without reopening, page through a long list, what an empty
// library says, and that the window still works after it is brought forward.
// Usage: node keo-myfiles-test.js <repo root> <extension folder> <work dir>
// A headed browser with the extension loaded, `localhost` unresolvable, a virtual authenticator with PRF. The extension has no way to point
// to a file where it lies, so that part of the window (the "Point to a file" button, the "kept on this computer" cards) is exercised by
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

// ---- reading the window (the page's own elements, as a person sees them)
const readWin = (frame) => frame.evaluate(() => {
  const wins = $world.submorphs.filter((m) => m.name === 'MyFilesBrowser'), root = document.querySelector('.mf-root');
  if (!wins.length || !root) return null;
  const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const rows = [...root.querySelectorAll('.mf-row')].map((r) => ({ id: r.dataset.id, name: (r.querySelector('.mf-nmx') || {}).title || '', meta: flat(r.querySelector('.mf-meta').innerText), sel: r.classList.contains('sel'),
    editing: !!r.querySelector('.mf-rename'), icon: r.querySelector('.mf-kind').innerText, editValue: (r.querySelector('.mf-rename') || {}).value }));
  const locs = [...root.querySelectorAll('.mf-loc')].map((l) => ({ name: flat((l.querySelector('.mf-nm') || {}).innerText), n: flat((l.querySelector('.mf-n') || {}).innerText), on: l.classList.contains('on'), id: l.dataset.folder || l.dataset.loc || null, editing: !!l.querySelector('input'),
    indent: parseInt(l.style.marginLeft || '0', 10) || 0 }));
  const st = root.querySelector('.mf-status');
  const th = root.querySelector('.mf-prev [data-el=thumb]');
  return { windows: wins.length, rows, locs, status: flat(st.querySelector('span') && st.querySelector('span').innerText), statusErr: st.classList.contains('err'), hasUndo: !!st.querySelector('[data-act=undo]'),
    prev: flat(root.querySelector('.mf-prev').innerText), prevName: flat((root.querySelector('.mf-prev .mf-t') || {}).innerText), thumbImg: !!(th && th.querySelector('img')),
    strip: flat((root.querySelector('.mf-selbar') || {}).innerText), query: root.querySelector('[data-el=q]').value, sort: root.querySelector('.mf-sort').value,
    pressed: [...root.querySelectorAll('.mf-kinds button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.innerText).join(),
    kinds: [...root.querySelectorAll('.mf-kinds button')].map((b) => b.innerText).join(),
    empty: flat((root.querySelector('.mf-empty') || {}).innerText), more: flat((root.querySelector('.mf-more') || {}).innerText), hasPoint: !!root.querySelector('.mf-point'),
    pop: flat((root.querySelector('.mf-pop') || {}).innerText), popItems: [...root.querySelectorAll('.mf-pop .mf-it')].map((i) => flat(i.innerText)),
    primaryDisabled: !!(root.querySelector('.mf-primary') || {}).disabled, size: (() => { const b = wins[0].renderContext().shapeNode.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; })() };
});
const names = (rows) => rows.map((r) => r.name);
const R = (s) => '.mf-root ' + s;
const row = (id) => R('.mf-row[data-id="' + id + '"]');
const click = (frame, sel, opts) => frame.click(sel, Object.assign({ timeout: 8000 }, opts || {}));
const front = (f) => f.evaluate(() => { $world.submorphs.find((m) => m.name === 'MyFilesBrowser').comeForward(); });
const hasText = (frame, src) => frame.evaluate((s) => { const re = new RegExp(s); let hit = false; (function walk(m) { if (hit) return; if (typeof m.textString === 'string' && re.test(m.textString)) hit = true; (m.submorphs || []).forEach(walk); })($world); return hit; }, src);
// the OK button of a question the world asks (a morph, found by its label)
const okClick = async (page, frame) => {
  const r = await frame.evaluate(() => { let found = null; (function walk(m) { if (found) return; if (m instanceof lively.morphic.Button && /^(OK|Yes)$/i.test(String(m.getLabel ? m.getLabel() : ''))) found = m; (m.submorphs || []).forEach(walk); })($world); if (!found) return null; const b = found.renderContext().shapeNode.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  if (!r) return false;
  const off = await (await frame.frameElement()).boundingBox();
  await page.mouse.click(off.x + r.x + r.w / 2, off.y + r.y + r.h / 2);
  return true;
};

// A file made in the library through the shell, as a drop makes one (name, type, bytes).
const addFile = (page, name, type, size, seed) => page.evaluate(async ([n, t, s, d]) => {
  const L = window.keoLibrary, bytes = new Uint8Array(s); for (let i = 0; i < s; i++) bytes[i] = (i * 31 + d) & 255;
  const b = await L.fileBegin({ name: n, type: t, size: Math.min(s, 4 * 1048576) === s ? s : s });
  for (let off = 0, k = 0; off < s; off += 4 * 1048576, k++) await L.fileChunk({ upload: b.upload, n: k, bytes: bytes.slice(off, Math.min(off + 4 * 1048576, s)) });
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
    await frame.evaluate(() => { const e = $world.get('IdentityMenuBarEntry'); e.morphMenuItems().find((i) => i[0] === 'My files')[1](); });
    let win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 4 ? s : null; });
    check('window: it opens and lists the four files, newest first', win && names(win.rows).join() === 'film.mp4,Meeting notes.pdf,tone.wav,sunset.png', win);
    await frame.evaluate(() => { const e = $world.get('IdentityMenuBarEntry'); e.morphMenuItems().find((i) => i[0] === 'My files')[1](); });
    await sleep(1200);
    win = await readWin(frame);
    check('window: asking again leaves one window', win.windows === 1);
    check('window: it opens at 820 x 580', Math.abs(win.size[0] - 820) <= 3 && Math.abs(win.size[1] - 580) <= 3, win.size);
    check('cards: each says its kind, its size and when it was added', win.rows.every((r) => /added (just now|\d+ min ago)/.test(r.meta)) && /^Video · 2 MB · added /.test(win.rows[0].meta) && /^PDF · 68\.4 KB · added /.test(win.rows[1].meta) && /^Audio · 4\.9 KB · added /.test(win.rows[2].meta) && /^Picture · 2\.9 KB · added /.test(win.rows[3].meta), win.rows.map((r) => r.meta));
    check('cards: each has the icon of its kind', win.rows.map((r) => r.icon).join() === 'video_file,picture_as_pdf,audio_file,image', win.rows.map((r) => r.icon));
    check('window: in the extension there is no "Point to a file" button, and no card says it is kept on this computer', !win.hasPoint && win.rows.every((r) => !/kept on this computer/.test(r.meta)), win);
    check('folders panel: All files (4) and Unsorted (4) and nothing else yet', win.locs.map((l) => l.name + ':' + l.n).join() === 'All files:4,Unsorted:4' && win.locs[0].on, win.locs);
    check('kinds: the pills are All, Pictures, Videos, Audios, Docs, and All is chosen', win.kinds === 'All,Pictures,Videos,Audios,Docs' && win.pressed === 'All', [win.kinds, win.pressed]);
    check('preview: with nothing chosen it says so', /Select a file to see it here/.test(win.prev), win.prev);
    check('the line under the list says how many files, what they take and how much room is left', !!(await until(async () => { const s = await readWin(frame); return s && /^4 files · 2\.1 MB kept in keo · room for about [\d.]+ [GT]B more$/.test(s.status); })), (await readWin(frame)).status);
    try { await page.screenshot({ path: path.join(WORK, 'myfiles-list.png') }); } catch (e) { /* a picture for a person to look at */ }

    // ---- search by real typing; filter by kind
    await click(frame, R('[data-el=q]'));
    await page.keyboard.type('TONE');
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 1 ? s : null; });
    check('search: typing "TONE" leaves the one file with that word in its name, whatever the case', win && names(win.rows).join() === 'tone.wav' && win.query === 'TONE', win);
    await page.keyboard.press('Control+A'); await page.keyboard.type('notes pdf');
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 1 && s.rows[0].name === 'Meeting notes.pdf' ? s : null; });
    check('search: words may be in any part of the name ("notes pdf")', !!win, await readWin(frame));
    await page.keyboard.press('Control+A'); await page.keyboard.type('zebra');
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 0 && /No file matches/.test(s.empty) ? s : null; });
    check('search: nothing found says so', !!win, await readWin(frame));
    await page.keyboard.press('Control+A'); await page.keyboard.press('Delete');
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 4 ? s : null; });
    check('search: clearing the field lists everything again', !!win, await readWin(frame));
    await click(frame, R('.mf-kinds button:text-is("Audios")'));
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 1 && s.pressed === 'Audios' ? s : null; });
    check('filter: "Audios" lists only sound', win && names(win.rows).join() === 'tone.wav', win);
    await click(frame, R('.mf-kinds button:text-is("Pictures")'));
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 1 && s.rows[0].name === 'sunset.png' ? s : null; });
    check('filter: "Pictures" lists only pictures', !!win, await readWin(frame));
    await click(frame, R('.mf-kinds button:text-is("Docs")'));
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 1 && s.rows[0].name === 'Meeting notes.pdf' ? s : null; });
    check('filter: "Docs" lists the PDF', !!win, await readWin(frame));
    await click(frame, R('.mf-kinds button:text-is("All")'));
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 4 ? s : null; });
    check('filter: "All" lists everything again', !!win, await readWin(frame));

    // ---- sort
    const sortBy = async (v, n) => { await frame.selectOption(R('.mf-sort'), v); return until(async () => { const s = await readWin(frame); return s && s.sort === v && names(s.rows).join() === n ? s : null; }); };
    check('sort: by name', !!(await sortBy('name', 'film.mp4,Meeting notes.pdf,sunset.png,tone.wav')), await readWin(frame));
    check('sort: largest first', !!(await sortBy('size', 'film.mp4,Meeting notes.pdf,tone.wav,sunset.png')), await readWin(frame));
    check('sort: by type (the ending of the name)', !!(await sortBy('type', 'film.mp4,Meeting notes.pdf,sunset.png,tone.wav')), await readWin(frame));
    check('sort: newest first again', !!(await sortBy('added', 'film.mp4,Meeting notes.pdf,tone.wav,sunset.png')), await readWin(frame));

    // ---- choosing files
    await click(frame, row(ids.notes) + ' .mf-nmx');
    win = await readWin(frame);
    check('choose: a click picks the file and the preview shows its details', win.rows.filter((r) => r.sel).map((r) => r.name).join() === 'Meeting notes.pdf' && /^Meeting notes\.pdf Type PDF Size 68\.4 KB Added just now|min ago Folder Unsorted/.test(win.prev.replace(/Added (just now|\d+ min ago)/, 'Added just now|min ago')) && /Stored Inside keo/.test(win.prev) && win.prevName === 'Meeting notes.pdf', win);
    check('choose: the preview has "Place in world" and "Remove from library …"', /Place in world/.test(win.prev) && /Remove from library …/.test(win.prev) && !/Stop using/.test(win.prev), win.prev);
    await click(frame, row(ids.sunset) + ' .mf-nmx');
    win = await until(async () => { const s = await readWin(frame); return s && s.thumbImg ? s : null; });
    check('choose: a picture is drawn in the preview', !!win, await readWin(frame));
    await click(frame, row(ids.tone) + ' .mf-nmx', { modifiers: ['Control'] });
    win = await readWin(frame);
    check('choose: Ctrl-click adds one, and a strip says "2 files selected" with Move to, Place, Remove and Clear', win.rows.filter((r) => r.sel).length === 2 && /^2 files selected Move to … Place in world Remove … Clear$/.test(win.strip) && /2 files selected/.test(win.prev), [win.strip, win.prev]);
    await click(frame, row(ids.film) + ' .mf-nmx');
    await click(frame, row(ids.tone) + ' .mf-nmx', { modifiers: ['Shift'] });
    win = await readWin(frame);
    check('choose: Shift-click picks the range between', win.rows.filter((r) => r.sel).map((r) => r.name).join() === 'film.mp4,Meeting notes.pdf,tone.wav', win.rows.map((r) => r.sel));
    await page.keyboard.press('Escape');
    win = await readWin(frame);
    check('choose: Esc lets go of the choice', win.rows.every((r) => !r.sel) && win.strip === '', win);
    await frame.hover(row(ids.film));
    await click(frame, row(ids.film) + ' .mf-chk');
    await click(frame, row(ids.notes) + ' .mf-chk');
    win = await readWin(frame);
    check('choose: the tick box picks without letting go of the others', win.rows.filter((r) => r.sel).map((r) => r.name).join() === 'film.mp4,Meeting notes.pdf', win);
    await click(frame, R('.mf-selbar .mf-clr'));
    win = await readWin(frame);
    check('choose: "Clear" lets go of them all', win.rows.every((r) => !r.sel) && win.strip === '', win);

    // ---- rename
    await frame.dblclick(row(ids.sunset) + ' .mf-nmx', { timeout: 8000 });
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.some((r) => r.editing) ? s : null; });
    const ed = win && win.rows.find((r) => r.editing);
    check('rename: double-clicking a name opens it for typing, without its ending', ed && ed.id === ids.sunset && ed.editValue === 'sunset' && /\.png/.test(await frame.evaluate(() => document.querySelector('.mf-row .mf-nmx .mf-ext') && document.querySelector('.mf-rename').parentNode.innerText)), ed);
    check('rename: the line says Enter keeps and Esc cancels', /Enter keeps the new name\. Esc keeps the old one\./.test(win.status), win.status);
    await page.keyboard.press('Control+A'); await page.keyboard.type('Beach at dusk'); await page.keyboard.press('Enter');
    win = await until(async () => { const s = await readWin(frame); return s && names(s.rows).includes('Beach at dusk.png') ? s : null; });
    check('rename: Enter keeps the new name and the ending stays', !!win && (await keoCall(frame, 'library.fileInfo', { id: ids.sunset })).r.name === 'Beach at dusk.png', win && win.rows.map((r) => r.name));
    check('rename: the line says so and offers Undo', win && /^Renamed to Beach at dusk\.png\.$/.test(win.status) && win.hasUndo, win && win.status);
    await click(frame, R('.mf-status [data-act=undo]'));
    win = await until(async () => { const s = await readWin(frame); return s && names(s.rows).includes('sunset.png') ? s : null; });
    check('rename: Undo puts the old name back', !!win && /^Undone\.$/.test(win.status) && (await keoCall(frame, 'library.fileInfo', { id: ids.sunset })).r.name === 'sunset.png', win && win.status);
    await click(frame, row(ids.tone) + ' .mf-nmx');
    await page.keyboard.press('F2');
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.some((r) => r.editing && r.id === ids.tone) ? s : null; });
    check('rename: F2 opens the chosen file\'s name', !!win, await readWin(frame));
    await page.keyboard.press('Control+A'); await page.keyboard.type('changed my mind'); await page.keyboard.press('Escape');
    win = await readWin(frame);
    check('rename: Esc keeps the old name', win.rows.every((r) => !r.editing) && names(win.rows).includes('tone.wav') && (await keoCall(frame, 'library.fileInfo', { id: ids.tone })).r.name === 'tone.wav', win);
    await page.keyboard.press('F2');
    await until(async () => { const s = await readWin(frame); return s && s.rows.some((r) => r.editing) ? s : null; });
    await page.keyboard.press('Control+A'); await page.keyboard.press('Delete'); await page.keyboard.press('Enter');
    win = await readWin(frame);
    check('rename: an empty name is refused and the field stays open', win.statusErr && /needs at least one letter or digit/.test(win.status) && win.rows.some((r) => r.editing), win);
    await page.keyboard.type('a/b'); await page.keyboard.press('Enter');
    win = await readWin(frame);
    check('rename: a name with a slash is refused and the field stays open', win.statusErr && /cannot hold any of/.test(win.status) && win.rows.some((r) => r.editing), win);
    await page.keyboard.press('Escape');
    const dupId = await addFile(page, 'dup.png', 'image/png', 1111, 9); await frame.evaluate(() => lively.identity.localFiles.changed());
    await until(async () => { const s = await readWin(frame); return s && s.rows.length === 5 ? s : null; });
    await frame.dblclick(row(dupId) + ' .mf-nmx', { timeout: 8000 });
    await until(async () => { const s = await readWin(frame); return s && s.rows.some((r) => r.editing) ? s : null; });
    await page.keyboard.press('Control+A'); await page.keyboard.type('sunset'); await page.keyboard.press('Enter');
    win = await until(async () => { const s = await readWin(frame); return s && /^Renamed to sunset\.png\./.test(s.status) ? s : null; });
    check('rename: a name another file here already has is allowed, with a warning', win && /Another file here has the same name\.$/.test(win.status), win && win.status);
    await keoCall(frame, 'library.fileRemove', { id: dupId });
    await click(frame, row(ids.film) + ' .mf-nmx');
    await click(frame, R('.mf-prev [data-act=prename]'));
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.some((r) => r.editing && r.id === ids.film) ? s : null; });
    check('rename: the pencil in the preview opens it too', !!win, await readWin(frame));
    await page.keyboard.press('Escape');

    // ---- folders: make, refuse a name, look inside, a folder inside a folder
    await click(frame, R('[data-act=newfolder]'));
    win = await until(async () => { const s = await readWin(frame); return s && s.locs.some((l) => l.editing) ? s : null; });
    check('folders: the new-folder button opens a field in the panel', !!win, win && win.locs);
    await page.keyboard.type('Holiday'); await page.keyboard.press('Enter');
    win = await until(async () => { const s = await readWin(frame); return s && s.locs.some((l) => l.name === 'Holiday') ? s : null; });
    check('folders: Enter makes the folder, looks inside it and says so', win && win.locs.find((l) => l.name === 'Holiday').on && /^Made the folder Holiday\.$/.test(win.status) && /Nothing here yet/.test(win.empty), win && [win.locs, win.status, win.empty]);
    const fl = (await keoCall(frame, 'library.folderList')).r;
    const HOL = fl.folders.find((f) => f.name === 'Holiday').id;
    check('folders: it is in the library', !!HOL);
    await click(frame, R('.mf-loc[data-loc=all]'));
    await click(frame, R('[data-act=newfolder]'));
    await page.keyboard.type('holiday'); await page.keyboard.press('Enter');
    win = await until(async () => { const s = await readWin(frame); return s && s.statusErr ? s : null; });
    check('folders: a second folder with the same name is refused in words', win && /already a folder called "holiday" here/.test(win.status) && win.locs.every((l) => !l.editing), win && win.status);
    await click(frame, R('.mf-loc[data-drop="' + HOL + '"]'));
    await click(frame, R('[data-act=newfolder]'));
    await page.keyboard.type('2026'); await page.keyboard.press('Enter');
    win = await until(async () => { const s = await readWin(frame); return s && s.locs.some((l) => l.name === '2026') ? s : null; });
    check('folders: made while looking at a top-level folder, a new one goes inside it, shown indented', win && /^Made the folder 2026 inside Holiday\.$/.test(win.status) && win.locs.find((l) => l.name === '2026').indent > 0, win && [win.status, win.locs]);
    await click(frame, R('.mf-loc[data-loc=all]'));

    // ---- moving: the preview's folder link, the strip, a real drag, Undo
    await click(frame, row(ids.tone) + ' .mf-nmx');
    await click(frame, R('.mf-prev [data-act=pmove]'));
    win = await until(async () => { const s = await readWin(frame); return s && s.popItems.length ? s : null; });
    check('move: the folder link in the preview opens the list of folders, the current one ticked', win && win.popItems.join('|') === 'check Unsorted|folder Holiday|folder 2026' && /^move to /i.test(win.pop), win && [win.pop, win.popItems]);
    await click(frame, R('.mf-pop .mf-it:has-text("Holiday")'));
    win = await until(async () => { const s = await readWin(frame); return s && /^Moved 1 file to Holiday\.$/.test(s.status) ? s : null; });
    check('move: choosing a folder moves the file and says so, with Undo', !!win && win.hasUndo && (await keoCall(frame, 'library.fileSearch', { folder: HOL })).r.items.map((i) => i.name).join() === 'tone.wav', win && win.status);
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.find((r) => r.id === ids.tone).meta.endsWith('in Holiday') ? s : null; });
    check('move: the card says which folder it is in (when looking at all files), and the counts follow', win && win.rows.find((r) => r.id === ids.tone).meta.endsWith('in Holiday') && win.locs.find((l) => l.name === 'Holiday').n === '1' && win.locs.find((l) => l.name === 'Unsorted').n === '3', win && [win.rows.map((r) => r.meta), win.locs]);
    check('move: the preview now names the folder', /Folder Holiday/.test(win.prev), win.prev);
    await click(frame, R('.mf-status [data-act=undo]'));
    win = await until(async () => { const s = await readWin(frame); return s && /^Undone\.$/.test(s.status) && s.locs.find((l) => l.name === 'Unsorted').n === '4' ? s : null; });
    check('move: Undo puts it back in no folder', !!win && (await keoCall(frame, 'library.fileInfo', { id: ids.tone })).r !== null && (await keoCall(frame, 'library.fileSearch', { folder: 'unsorted' })).r.total === 4, win && win.locs);
    // a real drag of a card onto a folder in the panel
    await frame.dragAndDrop(row(ids.tone), R('.mf-loc[data-drop="' + HOL + '"]'), { timeout: 8000 });
    win = await until(async () => { const s = await readWin(frame); return s && /^Moved 1 file to Holiday\.$/.test(s.status) ? s : null; });
    check('drag: dragging a card onto a folder moves the file', !!win && (await keoCall(frame, 'library.fileSearch', { folder: HOL })).r.items.map((i) => i.name).join() === 'tone.wav', win && [win.status, win.locs]);
    // several at once: choose two, drag one of them
    await click(frame, row(ids.film) + ' .mf-nmx');
    await click(frame, row(ids.notes) + ' .mf-nmx', { modifiers: ['Control'] });
    await frame.dragAndDrop(row(ids.film), R('.mf-loc[data-drop="' + HOL + '"]'), { timeout: 8000 });
    win = await until(async () => { const s = await readWin(frame); return s && /^Moved 2 files to Holiday\.$/.test(s.status) ? s : null; });
    check('drag: dragging one of the chosen cards takes all the chosen with it', !!win && (await keoCall(frame, 'library.fileSearch', { folder: HOL })).r.total === 3, (await readWin(frame)));
    // looking inside the folder, including the folders inside it
    await click(frame, R('.mf-loc[data-drop="' + HOL + '"]'));
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 3 && s.locs.find((l) => l.name === 'Holiday').on ? s : null; });
    check('folder: opening it lists its files (and no word about the folder on each card)', !!win && !win.rows.some((r) => /· in /.test(r.meta)), win && win.rows);
    // the strip's Move to …, with a folder made on the spot
    await click(frame, row(ids.film) + ' .mf-nmx');
    await click(frame, row(ids.notes) + ' .mf-nmx', { modifiers: ['Control'] });
    await click(frame, R('.mf-selbar [data-act=selmove]'));
    win = await until(async () => { const s = await readWin(frame); return s && s.popItems.length ? s : null; });
    check('move: from the strip the list says how many files it moves', win && /^move 2 files to /i.test(win.pop), win && win.pop);
    await click(frame, R('.mf-pop .mf-newrow input'));
    await page.keyboard.type('Work'); await page.keyboard.press('Enter');
    win = await until(async () => { const s = await readWin(frame); return s && /^Moved 2 files to Work\.$/.test(s.status) ? s : null; });
    const WORK_ID = (await keoCall(frame, 'library.folderList')).r.folders.find((f) => f.name === 'Work');
    check('move: a folder typed in the list is made and the files go into it', !!win && !!WORK_ID && (await keoCall(frame, 'library.fileSearch', { folder: WORK_ID.id })).r.total === 2, win && win.status);
    check('move: the open folder no longer lists them', win && win.rows.length === 1, win && win.rows.length);

    // ---- folders: rename and delete by right-click; deleting never deletes a file
    await frame.click(R('.mf-loc[data-folder="' + WORK_ID.id + '"]'), { button: 'right', timeout: 8000 });
    win = await until(async () => { const s = await readWin(frame); return s && s.popItems.length ? s : null; });
    check('folder menu: right-clicking a folder offers Rename folder … and Delete folder …, and says its files are kept', win && win.popItems.slice(0, 2).join('|') === 'Rename folder …|Delete folder …' && /not deleted/.test(win.pop), win && win.pop);
    await click(frame, R('.mf-pop .mf-it:has-text("Rename folder")'));
    win = await until(async () => { const s = await readWin(frame); return s && s.locs.some((l) => l.editing) ? s : null; });
    await page.keyboard.press('Control+A'); await page.keyboard.type('Projects'); await page.keyboard.press('Enter');
    win = await until(async () => { const s = await readWin(frame); return s && s.locs.some((l) => l.name === 'Projects') ? s : null; });
    check('folder menu: the new name is kept, and the files are still in it', !!win && /^Renamed the folder to Projects\.$/.test(win.status) && (await keoCall(frame, 'library.fileSearch', { folder: WORK_ID.id })).r.total === 2, win && [win.status, win.locs]);
    await frame.click(R('.mf-loc[data-folder="' + WORK_ID.id + '"]'), { button: 'right', timeout: 8000 });
    await until(async () => { const s = await readWin(frame); return s && s.popItems.length ? s : null; });
    await click(frame, R('.mf-pop .mf-it:has-text("Delete folder")'));
    win = await until(async () => { const s = await readWin(frame); return s && /^Deleted the folder Projects\./.test(s.status) ? s : null; });
    check('folder menu: deleting says where the files went, and no file is lost', !!win && /Its 2 files are now in Unsorted\.$/.test(win.status) && !win.locs.some((l) => l.name === 'Projects') && (await keoCall(frame, 'library.fileSearch', { folder: 'unsorted' })).r.total === 3, win && [win.status, win.locs]);
    win = await readWin(frame);
    check('folder menu: all four files are still there, one of them in Holiday', win.locs[0].n === '4' && win.locs.find((l) => l.name === 'Holiday').n === '1', win.locs);

    // ---- place files in the world
    await click(frame, R('.mf-loc[data-loc=all]'));
    await until(async () => { const s = await readWin(frame); return s && s.rows.length === 4 ? s : null; });
    await click(frame, row(ids.sunset) + ' .mf-nmx');
    await click(frame, R('.mf-prev [data-act=place]'));
    const placed = await until(() => frame.evaluate((id) => { let hit = null; $world.withAllSubmorphsDo((m) => { if (m.shape && m.shape.fileObjId === id && m.shape.fileHandle === 'keo:local') hit = m.constructor.type; }); return hit; }, ids.sunset), 15000);
    check('place: the green button puts the picture in the world as a dropped picture would be shown', placed === 'lively.data.FileUpload.EncryptedImage', placed);
    check('place: the line under the list says so', !!(await until(async () => { const s = await readWin(frame); return s && /^Placed “sunset\.png” in the world\.$/.test(s.status); })), (await readWin(frame)).status);
    await front(frame);
    await click(frame, row(ids.tone) + ' .mf-nmx');
    await click(frame, R('.mf-prev [data-act=place]'));
    const placed2 = await until(() => frame.evaluate((id) => { let hit = null; $world.withAllSubmorphsDo((m) => { if (m.shape && m.shape.fileObjId === id) { hit = m.constructor.type; } }); return hit; }, ids.tone), 15000);
    check('place: a sound is placed as a player', placed2 === 'lively.data.FileUpload.EncryptedAudio', [placed2, (await readWin(frame)).status, (await readWin(frame)).prevName]);
    const apart = await frame.evaluate((a) => { const f = (id) => { let p = null; $world.withAllSubmorphsDo((m) => { if (m.shape && m.shape.fileObjId === id) p = m.getPosition(); }); return p; }; const p1 = f(a[0]), p2 = f(a[1]); return p1 && p2 ? [Math.round(p2.x - p1.x), Math.round(p2.y - p1.y)] : null; }, [ids.sunset, ids.tone]);
    check('place: the second file lands a little lower and to the right of the first, so they do not hide each other', apart && apart[0] === 30 && apart[1] === 30, apart);
    await front(frame);
    await click(frame, row(ids.film) + ' .mf-nmx');
    await click(frame, row(ids.notes) + ' .mf-nmx', { modifiers: ['Control'] });
    await click(frame, R('.mf-selbar [data-act=place]'));
    check('place: the strip places every chosen file and says how many', !!(await until(async () => { const s = await readWin(frame); return s && /^Placed 2 files in the world\.$/.test(s.status); }, 20000)), (await readWin(frame)).status);
    await front(frame);

    // ---- the card's menu, and removing a file (the question is answered by clicking)
    await click(frame, row(ids.tone) + ' [data-act=more]');
    win = await until(async () => { const s = await readWin(frame); return s && s.popItems.length ? s : null; });
    check('card menu: a copy offers Place, Rename, Move to and Remove, and nothing about pointing', win && win.popItems.join('|') === 'Place in world|Rename …|Move to …|Remove from library …', win && win.popItems);
    await click(frame, R('.mf-pop .mf-it:has-text("Remove from library")'));
    check('remove: it asks first, and says worlds that show the file will not be able to, and that it cannot be undone', !!(await until(() => hasText(frame, 'Worlds that show it will not be able to show it any more\\. This cannot be undone'), 6000)) && (await keoCall(frame, 'library.fileInfo', { id: ids.tone })).r !== null);
    check('remove: the question has a button to confirm', await okClick(page, frame));
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 3 ? s : null; });
    check('remove: the card is gone, the library has no such file, and the line says so', win && !names(win.rows).includes('tone.wav') && (await keoCall(frame, 'library.fileInfo', { id: ids.tone })).r === null && /^Removed “tone\.wav”\.$/.test(win.status), win);
    // two at once, with the Delete key
    await click(frame, row(ids.film) + ' .mf-nmx');
    await click(frame, row(ids.notes) + ' .mf-nmx', { modifiers: ['Control'] });
    await page.keyboard.press('Delete');
    check('remove: the Delete key asks about all the chosen files together', !!(await until(() => hasText(frame, 'Remove these 2 files \\('), 6000)));
    await okClick(page, frame);
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 1 ? s : null; });
    check('remove: both are gone and the line says how many', win && /^Removed 2 files\.$/.test(win.status) && (await keoCall(frame, 'library.fileInfo', { id: ids.film })).r === null && (await keoCall(frame, 'library.fileInfo', { id: ids.notes })).r === null, win);

    // ---- a file added anywhere shows up without reopening (a drop goes through the same call)
    await frame.evaluate(() => new Promise((res) => { const f = new File([new Uint8Array(1234).fill(9)], 'late.gif', { type: 'image/gif' }); lively.identity.localFiles.put(f, {}, () => res()); }));
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 2 && s.rows[0].name === 'late.gif' ? s : null; });
    check('live: a file added while the window is open appears at the top', !!win, await readWin(frame));
    // renamed or moved somewhere else (the same calls the world makes): the window follows
    await keoCall(frame, 'library.fileRename', { id: ids.sunset, name: 'elsewhere.png' }); await frame.evaluate(() => lively.identity.localFiles.changed());
    win = await until(async () => { const s = await readWin(frame); return s && names(s.rows).includes('elsewhere.png') ? s : null; });
    check('live: a rename made elsewhere shows without reopening', !!win, await readWin(frame));
    await keoCall(frame, 'library.fileRename', { id: ids.sunset, name: 'sunset.png' }); await frame.evaluate(() => lively.identity.localFiles.changed());

    // ---- a long list is paged
    await frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'MyFilesBrowser').targetMorph; w._pageSize = 1; w._shown = 1; w.load(); });
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 1 && s.more ? s : null; });
    check('paging: with more files than fit a page, the list ends with "Show more (n more)"', win && win.more === 'Show more (1 more)', win && win.more);
    await click(frame, R('.mf-more'));
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 2 && !s.more ? s : null; });
    check('paging: "Show more" lists the rest', !!win, await readWin(frame));
    await frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'MyFilesBrowser').targetMorph; w._pageSize = 50; w._shown = 50; });

    // ---- brought forward: the window keeps working (a window's remove() also runs then)
    await frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'MyFilesBrowser'); w.comeForward(); });
    await sleep(600);
    await click(frame, row(ids.sunset) + ' .mf-nmx');
    win = await readWin(frame);
    check('forward: after the window is brought forward a click still picks a card and the preview shows it', win && win.windows === 1 && win.rows.filter((r) => r.sel).length === 1 && /sunset\.png/.test(win.prevName), win);
    await frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'MyFilesBrowser'); w.comeForward(); });
    await keoCall(frame, 'library.fileRemove', { id: (await keoCall(frame, 'library.fileSearch', { query: 'late' })).r.items[0].id }); await frame.evaluate(() => lively.identity.localFiles.changed());
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 1 ? s : null; });
    check('forward: and it still follows changes made elsewhere', !!win, await readWin(frame));

    // ---- an empty library says what to do
    for (const id of Object.values(ids)) await keoCall(frame, 'library.fileRemove', { id });
    const all = (await keoCall(frame, 'library.fileSearch', { query: '', limit: 200 })).r;
    for (const it of all.items) await keoCall(frame, 'library.fileRemove', { id: it.id });
    await frame.evaluate(() => lively.identity.localFiles.changed());
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 0 && /No files yet/.test(s.empty) ? s : null; });
    check('empty: with no files the list says to drop one onto a world (and, in the extension, does not mention pointing)', win && win.empty === 'folder_open No files yet. Drop a picture, video, audio or document onto a world.', win && win.empty);
    check('empty: the preview still says to choose a file', win && /Select a file to see it here/.test(win.prev), win && win.prev);
    try { await page.screenshot({ path: path.join(WORK, 'myfiles-empty.png') }); } catch (e) { /* a picture for a person to look at */ }

    check('no page errors', errors.length === 0, errors);
  } catch (e) {
    check('the run finished without an exception', false, String(e && e.stack || e));
  }
  await ctx.close();
  console.log(failed ? 'FAILED: ' + failed : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
