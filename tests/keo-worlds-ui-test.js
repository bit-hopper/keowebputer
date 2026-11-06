// The Worlds window (kernel: lively.identity.WorldLibrary) driven like a person would: open it from the world's menu, search by real
// typing, pick rows and press buttons with real mouse clicks, answer the name/tag/note prompts and the delete question by typing and
// clicking, and open a world by a double click.
// Usage: node keo-worlds-ui-test.js <repo root> <extension folder> <work dir>
// A headed browser with the extension loaded, `localhost` unresolvable, a virtual authenticator with PRF. Needs a package whose kernel
// snapshot holds WorldLibrary.js and the worldXxx calls of LocalIdentity.js (a refresh of kernel/ brings them).
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'cgjphijackijgcjkfdfieihkbfooigjp';
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
const shellCall = (page, fn, args) => page.evaluate(([f, a]) => window.keoWorlds[f](a).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [fn, args || {}]);
async function until(fn, ms) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > (ms || 12000)) return v; await sleep(250); } }

// ---- reading the window
const readLib = (frame) => frame.evaluate(() => {
  const win = $world.submorphs.find((m) => m.name === 'IdentityWorldLibrary');
  if (!win) return null;
  const list = win.get('worldsList');
  const text = (m, n) => { const t = m.submorphs.find((x) => x.name === n); return t ? String(t.textString) : ''; };
  const rows = (list ? list.submorphs : []).filter((m) => m.name === 'worldRow').map((r) => ({ name: r.worldName, shown: text(r, 'worldName'), meta: text(r, 'worldMeta'), snippet: text(r, 'worldSnippet'), bg: r.renderContext().shapeNode.style.background }));
  const empty = list && list.submorphs.find((m) => m.name === 'emptyText');
  const status = win.get('statusText');
  return { rows, empty: empty ? String(empty.textString) : null, status: status ? String(status.textString) : '', query: String(win.get('searchInput').textString), sel: win._d.sel };
});
// where a named morph's node is, in page coordinates (the world sits in an iframe)
async function rectOf(page, frame, evalFn, arg) {
  const r = await frame.evaluate(evalFn, arg);
  if (!r) return null;
  const off = await (await frame.frameElement()).boundingBox();
  return { x: off.x + r.x, y: off.y + r.y, w: r.w, h: r.h };
}
const nodeRect = (m) => { const b = m.renderContext().shapeNode.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
const rectOfNamed = (page, frame, name) => rectOf(page, frame, (n) => { const win = $world.submorphs.find((m) => m.name === 'IdentityWorldLibrary'); const m = win && win.get(n); if (!m) return null; const b = m.renderContext().shapeNode.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, name);
const rectOfRow = (page, frame, wname) => rectOf(page, frame, (n) => { const win = $world.submorphs.find((m) => m.name === 'IdentityWorldLibrary'); const r = win && win.get('worldsList').submorphs.find((m) => m.name === 'worldRow' && m.worldName === n); if (!r) return null; const b = r.renderContext().shapeNode.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, wname);
const click = async (page, r, opts) => { await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2, opts); };
// a Text morph anywhere in the world whose text matches: how a prompt or a question is told from the rest
const hasText = (frame, src) => frame.evaluate((s) => { const re = new RegExp(s); let hit = false; (function walk(m) { if (hit) return; if (typeof m.textString === 'string' && re.test(m.textString)) hit = true; (m.submorphs || []).forEach(walk); })($world); return hit; }, src);
// the "OK" button of the question that is up, in page coordinates
const okRect = (page, frame) => rectOf(page, frame, () => { let found = null; (function walk(m) { if (found) return; if (m instanceof lively.morphic.Button && /^(OK|Yes)$/i.test(String(m.getLabel ? m.getLabel() : ''))) found = m; (m.submorphs || []).forEach(walk); })($world); if (!found) return null; const b = found.renderContext().shapeNode.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-worlds-ui'), {
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

    // ---- three worlds to work with: one made by name with text typed into it, two saved through the shell
    await keoCall(frame, 'world.go', { kind: 'blank', name: 'Alpha notes' }).catch(() => {});
    frame = await waitForWorld(page, 'blank', 'Alpha notes');
    await frame.evaluate(() => { const t = new lively.morphic.Text(lively.rect(30, 90, 260, 40), 'Pineapple fritters for the picnic'); t.setName('picnic-list'); $world.addMorph(t); });
    await frame.evaluate(() => new Promise((res) => $world.saveWorld(() => res())));
    const doc = (await keoCall(frame, 'world.load', { name: 'Alpha notes' })).r.doc;
    await sleep(30);
    await shellCall(page, 'save', { name: 'Budget', doc: doc.split('Pineapple fritters for the picnic').join('Seeds 12 and soil 40'), tags: [], note: '' });
    await sleep(30);
    await shellCall(page, 'save', { name: 'Trip', doc: doc.split('Pineapple fritters for the picnic').join('Train at nine'), tags: ['travel'], note: 'in the spring' });
    check('setup: three worlds are saved', (await keoCall(frame, 'world.list')).r.length === 3);

    // ---- open the window from the world's menu
    const opened = await frame.evaluate(() => { const keo = $world.morphMenuItems().find((i) => i[0] === 'keo'); const it = keo && keo[1].find((i) => i[0] === 'Worlds ...'); if (!it) return false; it[1](); return true; });
    check('menu: keo > Worlds ... is offered', opened === true);
    let lib = await until(async () => { const s = await readLib(frame); return s && s.rows.length === 3 ? s : null; });
    check('window: it opens and lists the three worlds, newest first', lib && lib.rows.map((r) => r.name).join() === 'Trip,Budget,Alpha notes', lib);
    check('window: each row shows its name, when it was saved and its size', lib && lib.rows.every((x) => x.shown === x.name && /saved (just now|\d+ min ago)/.test(x.meta) && /\d+ (KB|B|MB)/.test(x.meta)), lib && lib.rows);
    check('window: the world saved last is marked', lib && /last saved/.test(lib.rows[0].meta) && !/last saved/.test(lib.rows[1].meta), lib && lib.rows);
    check('window: a world with tags shows them, and its note stands where a snippet would', lib && /#travel/.test(lib.rows[0].meta) && lib.rows[0].snippet === 'in the spring', lib && lib.rows[0]);
    check('window: the search field is empty, nothing is chosen', lib && lib.query === '' && lib.sel === null && lib.rows.every((r) => !r.bg));
    const shot = path.join(WORK, 'worlds-window.png');
    await page.screenshot({ path: shot });

    // ---- with nothing chosen, an action says so and changes nothing
    let r = await rectOfNamed(page, frame, 'renameBtn'); await click(page, r);
    lib = await until(async () => { const s = await readLib(frame); return s && /Choose a world/.test(s.status) ? s : null; }, 4000);
    check('buttons: with nothing chosen, Rename says to choose a world first, and no question opens', !!lib && !(await hasText(frame, 'New name for')), lib);

    // ---- search by real typing
    r = await rectOfNamed(page, frame, 'searchInput'); await click(page, r);
    await page.keyboard.type('pineapple', { delay: 25 });
    lib = await until(async () => { const s = await readLib(frame); return s && s.rows.length === 1 ? s : null; });
    check('search: typing "pineapple" leaves the one world with those words in it, with a snippet around them', lib && lib.rows[0].name === 'Alpha notes' && /Pineapple fritters/.test(lib.rows[0].snippet), lib);
    check('search: the field still has what was typed (the list was redrawn, the field was not)', lib && lib.query === 'pineapple', lib);
    await page.keyboard.type(' kiwi', { delay: 25 });
    lib = await until(async () => { const s = await readLib(frame); return s && s.empty ? s : null; });
    check('search: words that are not found say so', lib && /No world matches/.test(lib.empty) && /pineapple kiwi/.test(lib.empty), lib);
    await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
    lib = await until(async () => { const s = await readLib(frame); return s && s.rows.length === 3 ? s : null; });
    check('search: clearing the field brings every world back', !!lib && lib.query === '', lib);
    await page.keyboard.type('TRAVEL', { delay: 25 });
    lib = await until(async () => { const s = await readLib(frame); return s && s.rows.length === 1 ? s : null; });
    check('search: a tag is found, whatever the case', lib && lib.rows[0].name === 'Trip', lib);
    await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
    await until(async () => { const s = await readLib(frame); return s && s.rows.length === 3; });

    // ---- choose a row
    r = await rectOfRow(page, frame, 'Budget'); await click(page, r);
    lib = await readLib(frame);
    check('choose: a click marks that row, and only that one', lib.sel === 'Budget' && lib.rows.filter((x) => x.bg).map((x) => x.name).join() === 'Budget', lib);

    // ---- rename, by typing the answer
    r = await rectOfNamed(page, frame, 'renameBtn'); await click(page, r);
    check('rename: a question with the old name opens', !!(await until(() => hasText(frame, 'New name for .Budget'), 6000)));
    await page.keyboard.press('Control+A'); await page.keyboard.type('Budget 2026'); await page.keyboard.press('Enter');
    lib = await until(async () => { const s = await readLib(frame); return s && s.rows.some((x) => x.name === 'Budget 2026') ? s : null; });
    check('rename: the list shows the new name and not the old, and the world stays chosen', lib && !lib.rows.some((x) => x.name === 'Budget') && lib.sel === 'Budget 2026' && lib.rows.filter((x) => x.bg).map((x) => x.name).join() === 'Budget 2026', lib);
    check('rename: the shell has it under the new name', (await keoCall(frame, 'world.has', { name: 'Budget 2026' })).r === true && (await keoCall(frame, 'world.has', { name: 'Budget' })).r === false);

    // ---- a name that is taken is refused with a sentence
    r = await rectOfNamed(page, frame, 'renameBtn'); await click(page, r);
    await until(() => hasText(frame, 'New name for'), 6000);
    await page.keyboard.press('Control+A'); await page.keyboard.type('Trip'); await page.keyboard.press('Enter');
    lib = await until(async () => { const s = await readLib(frame); return s && /already exists/.test(s.status) ? s : null; });
    check('rename: onto a taken name says so, and both worlds are still there', !!lib && lib.rows.length === 3 && lib.rows.some((x) => x.name === 'Trip') && lib.rows.some((x) => x.name === 'Budget 2026'), lib);

    // ---- tags and a note: two questions
    r = await rectOfNamed(page, frame, 'metaBtn'); await click(page, r);
    check('tags: the first question asks for the tags', !!(await until(() => hasText(frame, 'Tags for'), 6000)));
    await page.keyboard.press('Control+A'); await page.keyboard.type('money, yearly'); await page.keyboard.press('Enter');
    check('tags: the second asks for a note', !!(await until(() => hasText(frame, 'A note about'), 6000)));
    await page.keyboard.press('Control+A'); await page.keyboard.type('check monthly'); await page.keyboard.press('Enter');
    lib = await until(async () => { const s = await readLib(frame); const b = s && s.rows.find((x) => x.name === 'Budget 2026'); return b && /#money #yearly/.test(b.meta) ? s : null; });
    check('tags: the row shows the tags, and the note where a snippet would be', !!lib && lib.rows.find((x) => x.name === 'Budget 2026').snippet === 'check monthly', lib);
    r = await rectOfNamed(page, frame, 'searchInput'); await click(page, r);
    await page.keyboard.press('Control+A'); await page.keyboard.type('yearly', { delay: 25 });
    lib = await until(async () => { const s = await readLib(frame); return s && s.rows.length === 1 ? s : null; });
    check('tags: the new tag is searchable', lib && lib.rows[0].name === 'Budget 2026', lib);
    await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
    await until(async () => { const s = await readLib(frame); return s && s.rows.length === 3; });

    // ---- copy
    r = await rectOfRow(page, frame, 'Budget 2026'); await click(page, r);
    r = await rectOfNamed(page, frame, 'copyBtn'); await click(page, r);
    const copyAsked = await until(() => hasText(frame, 'Name for the copy'), 6000);
    await page.keyboard.press('Enter');          // the suggested name is "<name> copy"
    lib = await until(async () => { const s = await readLib(frame); return s && s.rows.length === 4 ? s : null; });
    // which step failed, if one did: was the question up, is it still up, what did the shell end up with, where was the focus
    const copyDiag = lib ? null : { copyAsked, promptStillUp: await hasText(frame, 'Name for the copy'), library: await readLib(frame), shell: (await keoCall(frame, 'world.list')).r.map((w) => w.name), focus: await frame.evaluate(() => { const a = document.activeElement; return a ? a.tagName + '.' + String(a.className).slice(0, 40) : null; }) };
    check('copy: the suggested name makes a second world, which is then the chosen one', lib && lib.rows.some((x) => x.name === 'Budget 2026 copy') && lib.sel === 'Budget 2026 copy', copyDiag || lib);
    const menuNames = await frame.evaluate(() => { const keo = $world.morphMenuItems().find((i) => i[0] === 'keo'); const open = keo[1].find((i) => i[0] === 'Open'); return open[1].map((i) => i[0]); });
    check('the keo menu\'s own list of worlds follows a change made in the window', menuNames.some((n) => n.indexOf('Budget 2026 copy') === 0) && !menuNames.some((n) => n.replace(/ +\(last\)$/, '') === 'Budget'), menuNames);

    // ---- delete asks first
    r = await rectOfNamed(page, frame, 'deleteBtn'); await click(page, r);
    check('delete: it asks before anything is removed', !!(await until(() => hasText(frame, 'This cannot be undone'), 6000)) && (await keoCall(frame, 'world.has', { name: 'Budget 2026 copy' })).r === true);
    const ok = await okRect(page, frame);
    check('delete: the question has a button to confirm', !!ok);
    if (ok) await click(page, ok);
    lib = await until(async () => { const s = await readLib(frame); return s && s.rows.length === 3 ? s : null; });
    check('delete: it is gone from the list and from the shell, and nothing is chosen', lib && !lib.rows.some((x) => x.name === 'Budget 2026 copy') && lib.sel === null && (await keoCall(frame, 'world.has', { name: 'Budget 2026 copy' })).r === false, lib);

    // ---- a new world, by name; a taken name is refused and nothing restarts
    r = await rectOfNamed(page, frame, 'newBtn'); await click(page, r);
    await until(() => hasText(frame, 'Name for the new world'), 6000);
    await page.keyboard.type('Trip'); await page.keyboard.press('Enter');
    lib = await until(async () => { const s = await readLib(frame); return s && /already exists/.test(s.status) ? s : null; });
    check('new: a name that is taken is refused with a sentence, and this world is still running', !!lib && (await frame.evaluate(() => window.keo.init.startup.name)) === 'Alpha notes', lib);
    r = await rectOfNamed(page, frame, 'newBtn'); await click(page, r);
    await until(() => hasText(frame, 'Name for the new world'), 6000);
    await page.keyboard.type('Fresh start'); await page.keyboard.press('Enter');
    frame = await waitForWorld(page, 'blank', 'Fresh start');
    const l2 = (await keoCall(frame, 'world.list')).r;
    check('new: the world restarts blank under that name, and it is in the library at once', l2.some((w) => w.name === 'Fresh start') && l2.length === 4, l2.map((w) => w.name));

    // ---- open by a double click
    await frame.evaluate(() => { const keo = $world.morphMenuItems().find((i) => i[0] === 'keo'); keo[1].find((i) => i[0] === 'Worlds ...')[1](); });
    lib = await until(async () => { const s = await readLib(frame); return s && s.rows.length === 4 ? s : null; });
    r = await rectOfRow(page, frame, 'Trip');
    await page.mouse.dblclick(r.x + r.w / 2, r.y + r.h / 2);
    frame = await waitForWorld(page, 'world', 'Trip');
    const doc2 = await frame.evaluate(() => { let s = ''; (function walk(m) { if (typeof m.textString === 'string') s += m.textString + '|'; (m.submorphs || []).forEach(walk); })($world); return s; });
    check('open: a double click opens that world, with what was saved in it', /Train at nine/.test(doc2), doc2.slice(0, 200));

    // ---- the identity menu in the menu bar offers it too, and asking twice leaves one window
    const menu = await frame.evaluate(() => {
      const bar = $world.get(/MenuBar/), entry = $world.get('IdentityMenuBarEntry') || (bar && bar.submorphs.filter((m) => m.name === 'IdentityMenuBarEntry')[0]);
      const items = entry.morphMenuItems(), it = items.find((i) => i[0] === 'Worlds ...');
      if (it) { it[1](); it[1](); }
      return { labels: items.map((i) => i[0]), asked: !!it };
    });
    await sleep(1500);
    const wins = await frame.evaluate(() => $world.submorphs.filter((m) => m.name === 'IdentityWorldLibrary').length);
    check('identity menu: "Worlds ..." is offered after My homestar, and asking twice opens one window', menu.asked && menu.labels[1] === 'Worlds ...' && wins === 1, { menu, wins });
    await frame.evaluate(() => $world.submorphs.filter((m) => m.name === 'IdentityWorldLibrary').forEach((m) => m.remove()));

    // ---- the search palette finds a saved world by the text inside it, and Enter opens it
    await frame.evaluate(() => new Promise((res) => lively.require('lively.ide.tools.SearchPalette').toRun(() => { lively.ide.tools.SearchPalette.open(); res(); })));
    await sleep(600);
    await page.keyboard.type('fritters', { delay: 30 });
    const hit = await until(() => frame.evaluate(() => { const s = lively.ide.tools.SearchPalette.current; const m = s && (s.matches || []).filter((i) => i.group === 'worlds'); return m && m.length ? m.map((i) => ({ name: i.name, meta: i.meta, text: i.text })) : null; }));
    check('palette: a word written inside a saved world finds it under Saved worlds, with where it was found and a snippet', !!hit && hit.some((h) => h.name === 'Alpha notes' && /found in text/.test(h.meta) && /fritters/i.test(h.text)), hit);
    const noServer = await frame.evaluate(() => performance.getEntriesByType('resource').filter((r) => /\/@did|\/worlds$/.test(r.name)).map((r) => r.name));
    check('palette: nothing was asked of a host for saved worlds', noServer.length === 0, noServer);
    await page.keyboard.press('Enter');
    frame = await waitForWorld(page, 'world', 'Alpha notes');
    check('palette: Enter on that row opens the world', (await frame.evaluate(() => window.keo.init.startup.name)) === 'Alpha notes');

    check('no errors came from the page', errors.length === 0, errors);
  } catch (e) {
    check('the run finished', false, e.stack || String(e));
  } finally {
    await ctx.close().catch(() => {});
  }
  console.log(failed ? failed + ' check(s) FAILED' : 'all checks passed');
  process.exit(failed ? 1 : 0);
})();
