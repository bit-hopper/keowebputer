// "My worlds" (kernel: lively.identity.WorldsBrowser) used like a person would, on this device's own worlds: open it from the world's menu
// and the identity menu, search by real typing, open a world, use a row's menu to rename, tag, copy and delete (answering the prompts by
// typing and clicking), create a blank world and worlds from templates (which templates are offered, and that a template world is
// still there when it is opened again), and find a world from the search palette by the words written inside it.
// Usage: node keo-worlds-ui-test.js <repo root> <extension folder> <work dir>
// A headed browser with the extension loaded, `localhost` unresolvable, a virtual authenticator with PRF (so nothing here says anything
// about a real one). There is no host here, so the host's own behaviour of this window (envelopes, history) is NOT exercised.
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
const readWin = (frame) => frame.evaluate(() => {
  const win = $world.submorphs.find((m) => m.name === 'WorldsBrowser');
  if (!win) return null;
  const list = win.get('worldsList');
  const text = (m, n) => { const t = m.submorphs.find((x) => x.name === n); return t ? String(t.textString) : ''; };
  const rows = (list ? list.submorphs : []).filter((m) => m.name === 'worldRow').map((r) => ({ name: r.worldName, shown: text(r, 'worldName'), meta: text(r, 'worldMeta'), snippet: text(r, 'worldSnippet'), hasMore: !!r.submorphs.find((x) => x.name === 'worldMore'), hasOpen: !!r.submorphs.find((x) => x.name === 'worldOpen') }));
  const all = []; (function walk(m) { if (typeof m.textString === 'string' && m.textString.trim()) all.push(m.textString.trim()); (m.submorphs || []).forEach(walk); })(win);
  const status = win.get('worldsStatus'), cstatus = win._createStatusText;
  return { rows, all, message: list && list.submorphs.filter((m) => !m.name).map((m) => String(m.textString)).join('|'), status: status ? String(status.textString) : '', createStatus: cstatus ? String(cstatus.textString) : '', query: win.get('searchInput') ? String(win.get('searchInput').textString) : null, hasList: !!list };
});
// where a morph found by `pick` is, in page coordinates (the world sits in an iframe)
async function rectOf(page, frame, pick, arg) {
  // The element is scrolled into view first, as a person would scroll a long list to reach a row (a click on a clipped part misses it).
  const r = await frame.evaluate(([src, a]) => { const m = (new Function('return (' + src + ')'))()(a); if (!m) return null; const n = m.renderContext().shapeNode; try { n.scrollIntoView({ block: 'nearest' }); } catch (e) {} const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, [pick.toString(), arg]);
  if (!r) return null;
  const off = await (await frame.frameElement()).boundingBox();
  return { x: off.x + r.x, y: off.y + r.y, w: r.w, h: r.h };
}
const WIN = "$world.submorphs.find((m) => m.name === 'WorldsBrowser')";
const byName = (page, frame, name) => rectOf(page, frame, (n) => { const w = $world.submorphs.find((m) => m.name === 'WorldsBrowser'); return w && w.get(n); }, name);
const rowPart = (page, frame, world, part) => rectOf(page, frame, ([w, p]) => { const win = $world.submorphs.find((m) => m.name === 'WorldsBrowser'); const r = win && win.get('worldsList') && win.get('worldsList').submorphs.find((m) => m.name === 'worldRow' && m.worldName === w); return r && r.submorphs.find((x) => x.name === p); }, [world, part]);
// a Text anywhere in the world whose text is exactly `s` (a menu item, a card title)
const textRect = (page, frame, s) => rectOf(page, frame, (str) => { let hit = null; (function walk(m) { if (hit) return; if (typeof m.textString === 'string' && m.textString.trim() === str && m.renderContext && m.renderContext().shapeNode && m.renderContext().shapeNode.getBoundingClientRect().width > 0) hit = m; (m.submorphs || []).forEach(walk); })($world); return hit; }, s);
const hasText = (frame, src) => frame.evaluate((s) => { const re = new RegExp(s); let hit = false; (function walk(m) { if (hit) return; if (typeof m.textString === 'string' && re.test(m.textString)) hit = true; (m.submorphs || []).forEach(walk); })($world); return hit; }, src);
const click = async (page, r, opts) => { await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2, opts); };
const okRect = (page, frame) => rectOf(page, frame, () => { let found = null; (function walk(m) { if (found) return; if (m instanceof lively.morphic.Button && /^(OK|Yes)$/i.test(String(m.getLabel ? m.getLabel() : ''))) found = m; (m.submorphs || []).forEach(walk); })($world); return found; });
const names = (rows) => rows.map((r) => r.name);

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

    // ---- three worlds: one made by name with text typed into it, two saved through the shell
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

    // ---- opened from the world's keo menu, and from the identity menu (twice: one window)
    const opened = await frame.evaluate(() => { const keo = $world.morphMenuItems().find((i) => i[0] === 'keo'); const it = keo && keo[1].find((i) => i[0] === 'My worlds'); if (!it) return false; it[1](); return true; });
    check('menu: keo > My worlds is offered', opened === true);
    let win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 3 ? s : null; });
    check('window: it opens and lists the three worlds, newest first', win && names(win.rows).join() === 'Trip,Budget,Alpha notes', win);
    check('window: each row shows its type, when it was saved and its size', win && win.rows.every((x) => x.shown === x.name && /^World {2}· /.test(x.meta) && /saved (just now|\d+ min ago)/.test(x.meta) && /\d+ (KB|B|MB)/.test(x.meta)), win && win.rows);
    check('window: the world saved last is marked; tags show, and a note stands where a snippet would', win && /last saved/.test(win.rows[0].meta) && /#travel/.test(win.rows[0].meta) && win.rows[0].snippet === 'in the spring' && !/last saved/.test(win.rows[1].meta), win && win.rows);
    check('window: every row has "open" and the "⋯" menu, and there is no history link (a save keeps no versions here)', win && win.rows.every((x) => x.hasOpen && x.hasMore) && !win.all.includes('history'), win && win.all);
    await page.screenshot({ path: path.join(WORK, 'my-worlds-list.png') });
    const menu = await frame.evaluate(() => {
      const bar = $world.get(/MenuBar/), entry = $world.get('IdentityMenuBarEntry') || (bar && bar.submorphs.filter((m) => m.name === 'IdentityMenuBarEntry')[0]);
      const items = entry.morphMenuItems(), it = items.find((i) => i[0] === 'My worlds');
      if (it) { it[1](); it[1](); }
      return { labels: items.map((i) => i[0]), asked: !!it };
    });
    await sleep(1500);
    const wins = await frame.evaluate(() => $world.submorphs.filter((m) => m.name === 'WorldsBrowser').length);
    check('identity menu: "My worlds" is offered after My homestar, and asking again leaves one window', menu.asked && menu.labels[1] === 'My worlds' && wins === 1, { menu, wins });

    // ---- search by real typing
    let r = await byName(page, frame, 'searchInput'); await click(page, r);
    await page.keyboard.type('pineapple', { delay: 25 });
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 1 ? s : null; });
    check('search: typing "pineapple" leaves the one world with those words in it, with a snippet around them', win && win.rows[0].name === 'Alpha notes' && /Pineapple fritters/.test(win.rows[0].snippet), win);
    check('search: the field keeps what was typed (the list is redrawn, the field is not)', win && win.query === 'pineapple', win);
    await page.keyboard.type(' kiwi', { delay: 25 });
    win = await until(async () => { const s = await readWin(frame); return s && /No world matches/.test(s.message || '') ? s : null; });
    check('search: words that are not found say so', !!win && /pineapple kiwi/.test(win.message), win);
    await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 3 ? s : null; });
    check('search: clearing the field brings every world back', !!win, win);
    await page.keyboard.type('TRAVEL', { delay: 25 });
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 1 ? s : null; });
    check('search: a tag is found, whatever the case', win && win.rows[0].name === 'Trip', win);
    await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
    await until(async () => { const s = await readWin(frame); return s && s.rows.length === 3; });

    // ---- the row menu: rename, tags and note, copy, delete
    r = await rowPart(page, frame, 'Budget', 'worldMore'); await click(page, r);
    const menuItems = await until(async () => (await textRect(page, frame, 'Rename…')) ? true : null, 5000);
    const menuDiag = menuItems ? null : await frame.evaluate(() => {
      const texts = []; let menus = 0;
      (function walk(m) { if (m.constructor && /Menu/.test(String(m.constructor.type || m.constructor.name || ''))) menus++; if (typeof m.textString === 'string' && /Rename|Tags|Copy|Delete|prompt|New name/i.test(m.textString)) texts.push(m.textString.slice(0, 50)); (m.submorphs || []).forEach(walk); })($world);
      return { menus, texts, topLevel: $world.submorphs.map((m) => m.name || (m.constructor && m.constructor.type) || '?').slice(-8) };
    });
    check('row menu: the "⋯" opens Rename, Tags & note, Copy and Delete', !!menuItems && !!(await textRect(page, frame, 'Tags & note…')) && !!(await textRect(page, frame, 'Copy…')) && !!(await textRect(page, frame, 'Delete…')), menuDiag);
    await click(page, await textRect(page, frame, 'Rename…'));
    check('rename: a question with the old name opens', !!(await until(() => hasText(frame, 'New name for .Budget'), 6000)));
    await page.keyboard.press('Control+A'); await page.keyboard.type('Budget 2026'); await page.keyboard.press('Enter');
    win = await until(async () => { const s = await readWin(frame); return s && names(s.rows).includes('Budget 2026') ? s : null; });
    check('rename: the list shows the new name and not the old', win && !names(win.rows).includes('Budget'), win);
    check('rename: the shell has it under the new name', (await keoCall(frame, 'world.has', { name: 'Budget 2026' })).r === true && (await keoCall(frame, 'world.has', { name: 'Budget' })).r === false);

    r = await rowPart(page, frame, 'Budget 2026', 'worldMore'); await click(page, r);
    await until(() => textRect(page, frame, 'Rename…'), 5000);
    await click(page, await textRect(page, frame, 'Rename…'));
    await until(() => hasText(frame, 'New name for'), 6000);
    await page.keyboard.press('Control+A'); await page.keyboard.type('Trip'); await page.keyboard.press('Enter');
    win = await until(async () => { const s = await readWin(frame); return s && /already exists/.test(s.status) ? s : null; });
    check('rename: onto a taken name says so in the line under the list, and both worlds are still there', !!win && win.rows.length === 3 && names(win.rows).includes('Trip') && names(win.rows).includes('Budget 2026'), win);

    r = await rowPart(page, frame, 'Budget 2026', 'worldMore'); await click(page, r);
    await until(() => textRect(page, frame, 'Tags & note…'), 5000);
    await click(page, await textRect(page, frame, 'Tags & note…'));
    check('tags: the first question asks for the tags', !!(await until(() => hasText(frame, 'Tags for'), 6000)));
    await page.keyboard.press('Control+A'); await page.keyboard.type('money, yearly'); await page.keyboard.press('Enter');
    check('tags: the second asks for a note', !!(await until(() => hasText(frame, 'A note about'), 6000)));
    await page.keyboard.press('Control+A'); await page.keyboard.type('check monthly'); await page.keyboard.press('Enter');
    win = await until(async () => { const s = await readWin(frame); const b = s && s.rows.find((x) => x.name === 'Budget 2026'); return b && /#money #yearly/.test(b.meta) ? s : null; });
    check('tags: the row shows the tags, and the note where a snippet would be', !!win && win.rows.find((x) => x.name === 'Budget 2026').snippet === 'check monthly', win);
    r = await byName(page, frame, 'searchInput'); await click(page, r);
    await page.keyboard.press('Control+A'); await page.keyboard.type('yearly', { delay: 25 });
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 1 ? s : null; });
    check('tags: the new tag is searchable', win && win.rows[0].name === 'Budget 2026', win);
    await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
    await until(async () => { const s = await readWin(frame); return s && s.rows.length === 3; });

    r = await rowPart(page, frame, 'Budget 2026', 'worldMore'); await click(page, r);
    await until(() => textRect(page, frame, 'Copy…'), 5000);
    await click(page, await textRect(page, frame, 'Copy…'));
    await until(() => hasText(frame, 'Name for the copy'), 6000);
    await page.keyboard.press('Enter');          // the suggested name is "<name> copy"
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 4 ? s : null; });
    const copyDiag = win ? null : { promptStillUp: await hasText(frame, 'Name for the copy'), window: await readWin(frame), shell: (await keoCall(frame, 'world.list')).r.map((w) => w.name) };
    check('copy: the suggested name makes a second world', win && names(win.rows).includes('Budget 2026 copy'), copyDiag || win);
    const menuNames = await frame.evaluate(() => { const keo = $world.morphMenuItems().find((i) => i[0] === 'keo'); const open = keo[1].find((i) => i[0] === 'Open'); return open[1].map((i) => i[0]); });
    check('the keo menu\'s own list of worlds follows a change made in the window', menuNames.some((n) => n.indexOf('Budget 2026 copy') === 0) && !menuNames.some((n) => n.replace(/ +\(last\)$/, '') === 'Budget'), menuNames);

    r = await rowPart(page, frame, 'Budget 2026 copy', 'worldMore'); await click(page, r);
    await until(() => textRect(page, frame, 'Delete…'), 5000);
    await click(page, await textRect(page, frame, 'Delete…'));
    check('delete: it asks before anything is removed', !!(await until(() => hasText(frame, 'This cannot be undone'), 6000)) && (await keoCall(frame, 'world.has', { name: 'Budget 2026 copy' })).r === true);
    const ok = await okRect(page, frame);
    check('delete: the question has a button to confirm', !!ok);
    if (ok) await click(page, ok);
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 3 ? s : null; });
    check('delete: it is gone from the list and from the shell', win && !names(win.rows).includes('Budget 2026 copy') && (await keoCall(frame, 'world.has', { name: 'Budget 2026 copy' })).r === false, win);

    // ---- Create: the picker offers a blank world and a template (no wiki page: there is no wiki on this device)
    r = await byName(page, frame, 'createBtn'); await click(page, r);
    win = await until(async () => { const s = await readWin(frame); return s && s.all.includes('Create new') ? s : null; });
    check('create: the picker offers a blank world and a template, and no wiki page', !!win && win.all.includes('Blank world') && win.all.includes('Template') && !win.all.includes('Wiki page'), win && win.all);
    await page.screenshot({ path: path.join(WORK, 'my-worlds-create.png') });
    await click(page, await textRect(page, frame, 'Template'));
    win = await until(async () => { const s = await readWin(frame); return s && s.all.includes('Choose a template') ? s : null; });
    const hostTags = win ? win.all.filter((t) => t === 'Needs a host').length : -1;
    check('templates: all of them are listed; the three that still keep their data on a host say "Needs a host"', !!win && ['Shop', 'Import from Inventory', 'Gallery', 'Movie', 'Books', 'Game', 'Music', 'Diary'].every((t) => win.all.includes(t)) && hostTags === 3 && win.all.includes('Coming soon'), { hostTags, all: win && win.all });
    await page.screenshot({ path: path.join(WORK, 'my-worlds-templates.png') });
    await click(page, await textRect(page, frame, 'Gallery'));
    await sleep(800);
    win = await readWin(frame);
    check('templates: one that needs a host cannot be chosen (the list stays)', win.all.includes('Choose a template') && !win.all.includes('Name'), win.all);

    // ---- a Diary world: made from the template, saved with it, and still there when opened again
    await click(page, await textRect(page, frame, 'Diary'));
    win = await until(async () => { const s = await readWin(frame); return s && s.all.includes('New Diary world') ? s : null; });
    check('templates: choosing Diary asks for a name', !!win, win && win.all);
    r = await byName(page, frame, 'createNameInput'); await click(page, r);
    await page.keyboard.type('My diary', { delay: 25 });
    await click(page, await byName(page, frame, 'createSubmitBtn'));
    frame = await waitForWorld(page, 'blank', 'My diary');
    check('diary: the world restarts blank under that name, with the template named', (await frame.evaluate(() => window.keo.init.startup.template)) === 'diary');
    check('diary: the template\'s screen is in the world', !!(await until(() => hasText(frame, 'Your diary will live here'), 15000)));
    const dl = await until(async () => { const l = (await keoCall(frame, 'world.list')).r.find((w) => w.name === 'My diary'); return l && l.template === 'diary' ? l : null; });
    check('diary: it is in the library at once, marked as made from that template', !!dl, dl);
    // saved again once the template's morph was in the world: the saved page must hold it
    const savedHasDiary = await until(async () => { const d = (await keoCall(frame, 'world.load', { name: 'My diary' })).r; return d && /Your diary will live here/.test(d.doc); }, 20000);
    check('diary: what is saved is the world with the template in it, not the empty world', !!savedHasDiary);

    // ---- a Shop world, same thing (a DOM-built screen this time)
    await frame.evaluate(() => { const keo = $world.morphMenuItems().find((i) => i[0] === 'keo'); keo[1].find((i) => i[0] === 'My worlds')[1](); });
    await until(async () => { const s = await readWin(frame); return s && s.rows.length >= 4; });
    await click(page, await byName(page, frame, 'createBtn'));
    await until(async () => (await textRect(page, frame, 'Template')) ? true : null, 6000);
    await click(page, await textRect(page, frame, 'Template'));
    await until(async () => (await textRect(page, frame, 'Shop')) ? true : null, 6000);
    await click(page, await textRect(page, frame, 'Shop'));
    await until(async () => (await byName(page, frame, 'createNameInput')) ? true : null, 6000);
    await click(page, await byName(page, frame, 'createNameInput'));
    await page.keyboard.type('My shop', { delay: 25 });
    await click(page, await byName(page, frame, 'createSubmitBtn'));
    frame = await waitForWorld(page, 'blank', 'My shop');
    const shopShown = await until(async () => (await frame.getByText('Find something made with care').count()) > 0, 20000);
    check('shop: the storefront is in the world', !!shopShown);
    const shopSaved = await until(async () => { const d = (await keoCall(frame, 'world.load', { name: 'My shop' })).r; return d && /Find something made with care/.test(d.doc); }, 20000);
    check('shop: what is saved holds the storefront', !!shopSaved);

    // ---- a Books world, chosen from the picker: its library is made on this device and the saved world remembers it
    await frame.evaluate(() => { const keo = $world.morphMenuItems().find((i) => i[0] === 'keo'); keo[1].find((i) => i[0] === 'My worlds')[1](); });
    await until(async () => { const s = await readWin(frame); return s && s.rows.length >= 5; });
    await click(page, await byName(page, frame, 'createBtn'));
    await until(async () => (await textRect(page, frame, 'Template')) ? true : null, 6000);
    await click(page, await textRect(page, frame, 'Template'));
    await until(async () => (await textRect(page, frame, 'Books')) ? true : null, 6000);
    await click(page, await textRect(page, frame, 'Books'));
    win = await until(async () => { const s = await readWin(frame); return s && s.all.includes('New Books world') ? s : null; });
    check('books: Books can be chosen (it needs no host here) and asks for a name', !!win, win && win.all);
    await click(page, await byName(page, frame, 'createNameInput'));
    await page.keyboard.type('My books', { delay: 25 });
    await click(page, await byName(page, frame, 'createSubmitBtn'));
    frame = await waitForWorld(page, 'blank', 'My books');
    const booksLib = await until(() => frame.evaluate(() => { const m = $world.submorphs.find((x) => x.name === 'Books'); return m && m.state && m.state.loaded && m.booksLibraryObjId ? m.booksLibraryObjId : null; }), 25000);
    check('books: the app is in the world and its library was made on this device', !!booksLib, booksLib);
    const booksSaved = await until(async () => { const d = (await keoCall(frame, 'world.load', { name: 'My books' })).r; return d && booksLib && d.doc.indexOf(booksLib) >= 0 ? d : null; }, 20000);
    check('books: what is saved holds the library id, so opening the world again does not make another', !!booksSaved);
    const bl = (await keoCall(frame, 'world.list')).r.find((w) => w.name === 'My books');
    check('books: the library lists it as made from that template', !!bl && bl.template === 'books', bl);

    // ---- a blank world from the Create page, by name; a name that is taken is refused and nothing restarts
    await frame.evaluate(() => { const keo = $world.morphMenuItems().find((i) => i[0] === 'keo'); keo[1].find((i) => i[0] === 'My worlds')[1](); });
    await until(async () => { const s = await readWin(frame); return s && s.rows.length >= 5; });
    await click(page, await byName(page, frame, 'createBtn'));
    await until(async () => (await textRect(page, frame, 'Blank world')) ? true : null, 6000);
    await click(page, await textRect(page, frame, 'Blank world'));
    await until(async () => (await byName(page, frame, 'createNameInput')) ? true : null, 6000);
    await click(page, await byName(page, frame, 'createNameInput'));
    await page.keyboard.type('Trip', { delay: 25 });
    await click(page, await byName(page, frame, 'createSubmitBtn'));
    win = await until(async () => { const s = await readWin(frame); return s && /already exists/.test(s.createStatus) ? s : null; });
    check('create: a name that is taken is refused with a sentence, and this world keeps running', !!win && (await frame.evaluate(() => window.keo.init.startup.name)) === 'My books', win);
    await click(page, await byName(page, frame, 'createNameInput'));
    await page.keyboard.press('Control+A'); await page.keyboard.type('Fresh start', { delay: 25 });
    await click(page, await byName(page, frame, 'createSubmitBtn'));
    frame = await waitForWorld(page, 'blank', 'Fresh start');
    const fl = (await keoCall(frame, 'world.list')).r.find((w) => w.name === 'Fresh start');
    check('create: the blank world restarts under that name and is in the library, with no template', !!fl && fl.template === null, fl);

    // ---- open a world from the list with the "open" link; the template worlds are as they were saved
    await frame.evaluate(() => { const keo = $world.morphMenuItems().find((i) => i[0] === 'keo'); keo[1].find((i) => i[0] === 'My worlds')[1](); });
    await until(async () => { const s = await readWin(frame); return s && s.rows.length >= 6; });
    await click(page, await rowPart(page, frame, 'My diary', 'worldOpen'));
    frame = await waitForWorld(page, 'world', 'My diary');
    check('open: "open" on a template world brings it back as it was saved (the diary is there)', !!(await until(() => hasText(frame, 'Your diary will live here'), 15000)));
    await frame.evaluate(() => { const keo = $world.morphMenuItems().find((i) => i[0] === 'keo'); keo[1].find((i) => i[0] === 'My worlds')[1](); });
    await until(async () => { const s = await readWin(frame); return s && s.rows.length >= 6; });
    await click(page, await rowPart(page, frame, 'Trip', 'worldOpen'));
    frame = await waitForWorld(page, 'world', 'Trip');
    check('open: and an ordinary world with what was written in it', !!(await until(() => hasText(frame, 'Train at nine'), 10000)));

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
