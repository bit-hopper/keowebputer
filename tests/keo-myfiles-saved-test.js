// A world saved while the "My files" window is open: opened again, the window comes back with its page content (the content is not part of
// what is saved, so the window rebuilds it when it is restored), with what the person had set (the search words and the sort), reads the
// library, and works (a real click picks a card). Also that a window is not duplicated and the saved world stays small.
// Usage: node keo-myfiles-saved-test.js <repo root> <extension folder> <work dir>
// A headed browser with the extension loaded, `localhost` unresolvable, a virtual authenticator with PRF.
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
const addFile = (page, name, type, size, seed) => page.evaluate(async ([n, t, s, d]) => {
  const L = window.keoLibrary, bytes = new Uint8Array(s); for (let i = 0; i < s; i++) bytes[i] = (i * 31 + d) & 255;
  const b = await L.fileBegin({ name: n, type: t, size: s }); await L.fileChunk({ upload: b.upload, n: 0, bytes });
  return (await L.fileEnd({ upload: b.upload })).id;
}, [name, type, size, seed]);
const state = (frame) => frame.evaluate(() => {
  const wins = $world.submorphs.filter((m) => m.name === 'MyFilesBrowser'), root = document.querySelector('.mf-root');
  return { windows: wins.length, roots: document.querySelectorAll('.mf-root').length, hasRoot: !!root, q: root ? root.querySelector('[data-el=q]').value : null, sort: root ? root.querySelector('.mf-sort').value : null,
    rows: root ? [...root.querySelectorAll('.mf-row')].map((r) => (r.querySelector('.mf-nmx') || {}).title) : null, sel: root ? root.querySelectorAll('.mf-row.sel').length : null };
});

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-myfiles-saved'), {
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
    await keoCall(frame, 'world.go', { kind: 'blank', name: 'Saved files room' }).catch(() => {});
    frame = await waitForWorld(page, 'blank', 'Saved files room');
    await addFile(page, 'beach one.png', 'image/png', 2000, 1); await sleep(40);
    await addFile(page, 'beach two.png', 'image/png', 3000, 2); await sleep(40);
    await addFile(page, 'notes.pdf', 'application/pdf', 4000, 3);

    await frame.evaluate(() => { $world.get('IdentityMenuBarEntry').morphMenuItems().find((i) => i[0] === 'My files')[1](); });
    let s = await until(async () => { const x = await state(frame); return x.rows && x.rows.length === 3 ? x : null; });
    check('the window is open and lists the three files', !!s, await state(frame));
    await frame.click('.mf-root [data-el=q]'); await page.keyboard.type('beach');
    await frame.selectOption('.mf-root .mf-sort', 'name');
    s = await until(async () => { const x = await state(frame); return x.rows && x.rows.join() === 'beach one.png,beach two.png' && x.sort === 'name' ? x : null; });
    check('the person searches for "beach" and sorts by name', !!s, await state(frame));
    const saved = await frame.evaluate(() => new Promise((res) => $world.saveWorldAs(URL.root.withFilename('saved-files-room.html'), false, undefined, (e) => res(e ? { err: e.message } : { ok: true }))));
    check('the world saves with the window open', saved.ok === true, saved);
    const list = await keoCall(frame, 'world.list');
    const row = list.ok && list.r.find((w) => w.name === 'saved-files-room');
    check('the saved world is small (the window\'s page content and the files are not in it)', !!row && row.bytes < 400000, row);

    await page.reload();
    frame = await waitForWorld(page, 'world');
    s = await until(async () => { const x = await state(frame); return x.hasRoot && x.rows && x.rows.length === 2 ? x : null; }, 20000);
    check('opened again: one window, with its page content rebuilt', !!s && s.windows === 1 && s.roots === 1, await state(frame));
    check('it has the search words and the sort the person had set, and lists the library accordingly', !!s && s.q === 'beach' && s.sort === 'name' && s.rows.join() === 'beach one.png,beach two.png', s);
    await frame.click('.mf-root .mf-row .mf-nmx');
    s = await until(async () => { const x = await state(frame); return x.sel === 1 ? x : null; }, 6000);
    check('and it works: a click picks a card', !!s, await state(frame));
    await keoCall(frame, 'library.fileSearch', { query: 'beach' });
    await page.keyboard.press('Control+A'); await frame.click('.mf-root [data-el=q]'); await page.keyboard.press('Control+A'); await page.keyboard.press('Delete');
    s = await until(async () => { const x = await state(frame); return x.rows && x.rows.length === 3 ? x : null; });
    check('clearing the search lists all three: typing works in the restored window', !!s, await state(frame));
    check('no page errors', errors.length === 0, errors);
  } catch (e) {
    check('the run finished without an exception', false, String(e && e.stack || e));
  }
  await ctx.close();
  console.log(failed ? 'FAILED: ' + failed : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
