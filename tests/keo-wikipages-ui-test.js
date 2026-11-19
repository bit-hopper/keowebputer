// Wiki pages on this device, used the way a person would. A wiki page is a kind of world, listed in the "My worlds" window (kernel
// lively.identity.WorldsBrowser) and opened from its row there; it is MADE in the wiki's index (the Create card goes there: that, and the
// index itself, are tests/keo-wikiindex-ui-test.js), so here a page starts as the shell is asked to go to it by name, as the index does for a page
// that is not saved yet. Going to a page MOVES the person to a world of its own (the shell restarts the world frame with start kind 'wiki', world/keo-boot.js) in which
// the page's editor (kernel lively.identity.WikiEditor.openLocal) fills the world, as a page of a wiki does on a host: not a window. Real
// typing, the autosave into the shell's sealed store (shell/keo-wikipages.js), the page in the same list as the worlds (labelled Wiki,
// found by search), leaving with text typed in the last moments (it is saved first), a refused save that keeps the person on the page,
// a reload of the whole page (it comes back to the page, and forgets it after a move elsewhere or a sign-out), the page following the browser
// window's size, a code cell run in the page, and the shell refusing a page it does not hold. No separate "Wiki pages" menu entry.
//
// Needs a package whose kernel files are the ones with LocalIdentity.wikiGo, WikiEditor.openLocal as the world and the Wiki page card in
// My worlds.
// Usage: [KEO_HEADLESS=1] node keo-wikipages-ui-test.js <repo root> <package folder> <work dir>
// Headed unless KEO_HEADLESS=1 (the mode is printed first). A headless pass is not a headed pass. NOT covered: a real authenticator, another
// browser, history, sync between devices, embeds, the page in the desktop app, a page of someone else's opened through the shell (the
// shell refuses one it does not hold; the editor's read-only look is checked by opening it in the editor directly, step 8).
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const Y = require(path.join(__dirname, '..', 'shell', 'keo-yjs.js'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 900) : '')); if (!ok) failed++; }
const note = (s) => console.log('NOTE ' + s);
const errors = [];
let phase = '0 start';
const headless = !!process.env.KEO_HEADLESS;

const worldFrame = (page) => page.frames().find((f) => /world\.html$/.test(f.url()));
// The world frame that has started as `kind` (the shell replaces the frame at every move, so the handle of the one before is dead).
async function waitForWorld(page, kind) {
  let frame = null;
  for (let i = 0; i < 200; i++) {
    frame = worldFrame(page);
    if (frame) { try { if (await frame.evaluate((k) => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind === k), kind)) break; } catch (e) { /* not ready */ } }
    frame = null; await sleep(300);
  }
  if (!frame) throw new Error('the world did not start as ' + kind);
  await sleep(2500);
  return frame;
}
// The world that comes up, of whatever kind, and what kind it is (null when none did): after a reload the person may land anywhere, and a
// wrong landing has to fail the check that names it, not end the run in a wait.
async function landedOn(page) {
  for (let i = 0; i < 200; i++) {
    const f = worldFrame(page);
    if (f) { try { const k = await f.evaluate(() => (window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind) || null); if (k) { await sleep(2500); return { frame: f, kind: k }; } } catch (e) { /* not ready */ } }
    await sleep(300);
  }
  return { frame: null, kind: null };
}
// `update` goes in as plain numbers and is made into bytes inside the frame, the way an editor hands them over (as in the bridge test).
const keoCall = (frame, op, args) => frame.evaluate(([o, a]) => {
  if (a && Array.isArray(a.update)) a.update = new Uint8Array(a.update);
  return window.keo.call(o, a, 60000).then((r) => {
    if (r && r.state) { r.state = Array.from(r.state); }
    return { ok: true, r };
  }, (e) => ({ ok: false, e: e.message }));
}, [op, args || {}]);
async function until(fn, ms) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > (ms || 12000)) return v; await sleep(250); } }
// where a morph or node found by `pick` is, in page coordinates (the world sits in an iframe)
async function rectOf(frame, pick, arg) {
  const r = await frame.evaluate(([src, a]) => { const m = (new Function('return (' + src + ')'))()(a); if (!m) return null; const n = m.renderContext ? m.renderContext().shapeNode : m; try { n.scrollIntoView({ block: 'nearest' }); } catch (e) {} const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, [pick.toString(), arg]);
  if (!r) return null;
  const off = await (await frame.frameElement()).boundingBox();
  return { x: off.x + r.x, y: off.y + r.y, w: r.w, h: r.h };
}
// The "My worlds" window (WorldsBrowser): a named part of it, a part of the row of a world or page, and a Text anywhere (a card's title).
const byName = (frame, name) => rectOf(frame, (n) => { const w = $world.submorphs.find((m) => m.name === 'WorldsBrowser'); return w && w.get(n); }, name);
const rowPart = (frame, rowName, part) => rectOf(frame, ([w, p]) => { const win = $world.submorphs.find((m) => m.name === 'WorldsBrowser'); const r = win && win.get('worldsList') && win.get('worldsList').submorphs.find((m) => m.name === 'worldRow' && m.worldName === w); return r && r.submorphs.find((x) => x.name === p); }, [rowName, part]);
const textRect = (frame, s) => rectOf(frame, (str) => { let hit = null; (function walk(m) { if (hit) return; if (typeof m.textString === 'string' && m.textString.trim() === str && m.renderContext && m.renderContext().shapeNode && m.renderContext().shapeNode.getBoundingClientRect().width > 0) hit = m; (m.submorphs || []).forEach(walk); })($world); return hit; }, s);
// What the window shows: its rows (a page's row has `wiki`), every text in it, whether it is showing the list, the line under the list.
const readWin = (frame) => frame.evaluate(() => {
  const win = $world.submorphs.find((m) => m.name === 'WorldsBrowser');
  if (!win) return null;
  const list = win.get('worldsList'), text = (m, n) => { const t = m.submorphs.find((x) => x.name === n); return t ? String(t.textString) : ''; };
  const rows = (list ? list.submorphs : []).filter((m) => m.name === 'worldRow').map((r) => ({ name: r.worldName, meta: text(r, 'worldMeta'), wiki: !!r.wikiId, id: r.wikiId || null, hasMore: !!r.submorphs.find((x) => x.name === 'worldMore'), hasOpen: !!r.submorphs.find((x) => x.name === 'worldOpen') }));
  const all = []; (function walk(m) { if (typeof m.textString === 'string' && m.textString.trim()) all.push(m.textString.trim()); (m.submorphs || []).forEach(walk); })(win);
  const status = win.get('worldsStatus');
  return { rows, all, hasList: !!list, message: list && list.submorphs.filter((m) => !m.name).map((m) => String(m.textString)).join('|'), status: status ? String(status.textString) : '', query: win.get('searchInput') ? String(win.get('searchInput').textString) : null };
});
// The editor of the page called `name` (the one in this world), what it is, its text, its state; null when none is open.
const readEditor = (frame, name) => frame.evaluate((n) => {
  const e = (lively.identity.WikiEditor.localEditors ? lively.identity.WikiEditor.localEditors() : []).filter((x) => x._wikiName === n)[0];
  if (!e) return null;
  const pm = e._pmContainer && e._pmContainer.querySelector('.ProseMirror'), win = e.getWindow && e.getWindow();
  const bar = $world.get(/^MenuBar/), entry = bar && bar.submorphs.find((m) => m.name === 'WorldNameMenuBarEntry');
  return { local: !!e._local, name: e._wikiName, objId: e._objId, canEdit: !!e._canEdit, hasView: !!e.editorView, text: pm ? pm.textContent : null, status: e._statusEl ? e._statusEl.textContent : null,
    buttons: e._toolbarDiv ? Array.from(e._toolbarDiv.querySelectorAll('button')).map((b) => b.textContent) : [], toolbarLabel: e._toolbarDiv ? e._toolbarDiv.textContent.slice(-120) : '',
    clientId: e.yDoc ? e.yDoc.clientID : null, session: e._pageSession || null, unsaved: e._unsaved ? e._unsaved.length : null,
    inWorld: e.owner === $world, inWindow: !!(win && win !== e), worldName: entry ? String(entry.textString) : null };
}, name);
const pmRect = (frame, name) => rectOf(frame, (n) => { const e = (lively.identity.WikiEditor.localEditors ? lively.identity.WikiEditor.localEditors() : []).filter((x) => x._wikiName === n)[0]; return e && e._pmContainer && e._pmContainer.querySelector('.ProseMirror'); }, name);
const click = async (page, r) => { await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2); };
const textOfState = (arr) => { const d = new Y.Doc(); if (arr && arr.length) Y.applyUpdate(d, Uint8Array.from(arr)); return d.getXmlFragment('prosemirror').toString().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); };
// the text the shell holds for a page, read through a session of the test's own that is closed again
const shellText = async (frame, name) => { const l = await keoCall(frame, 'wiki.open', { name }); if (!l.ok) return null; const t = textOfState(l.r.state); await keoCall(frame, 'wiki.close', { session: l.r.session }); return t; };
// Whether this world is still the one the marker was put in (a world that was replaced answers with an error, which is "no": a check that
// the person stayed must fail by its name, not end the run).
const stillHere = async (frame, name) => { try { return (await frame.evaluate(() => window.__sameWorld)) === 'yes' && !!(await readEditor(frame, name)); } catch (e) { return false; } };
// Where the page's editor is and how big, the menu bar's bottom edge and the world's size, in the world's own coordinates.
const fitOf = (frame) => frame.evaluate(() => { const e = lively.identity.WikiEditor.localEditors()[0], b = e.getBounds(), v = $world.visibleBounds(), bar = $world.get(/^MenuBar/), bb = bar.getBounds(); return { editorTop: b.y, barBottom: bb.y + bb.height, left: b.x, right: b.x + b.width, bottom: b.y + b.height, w: b.width, h: b.height, worldW: v.width, worldH: v.height }; });
const fits = (g) => g.editorTop >= g.barBottom && g.left >= 0 && g.right <= g.worldW && g.bottom <= g.worldH;
const versionsOf = async (frame, name) => { const l = await keoCall(frame, 'wiki.list'); const p = l.ok && l.r.filter((x) => x.name === name)[0]; return p ? p.versions : 0; };

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const profile = path.join(WORK, 'profile-wikiui-' + process.pid);
  const ctx = await chromium.launchPersistentContext(profile, Object.assign({ headless, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] }, headless ? { channel: 'chromium' } : {}));
  console.log('MODE ' + (headless ? 'HEADLESS (newer headless mode, channel chromium)' : 'headed') + '; browser ' + (ctx.browser() ? ctx.browser().version() : 'unknown') + '; package ' + path.basename(EXT));
  await sleep(2500);
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure|ERR_FILE_NOT_FOUND|youtube\.com|Geolocation/.test(m.text())) errors.push('console: [' + phase + '] ' + m.text().slice(0, 200)); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });

    await page.goto(`chrome-extension://${ID}/start.html`);
    let frame = await waitForWorld(page, 'gate');
    await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }));
    await keoCall(frame, 'world.go', { kind: 'enter' }).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    const did = await page.evaluate(() => window.keoIdentity.current().then((s) => s.did));
    // `frame` is looked up when these run: the world frame is a new one after every move.
    const openList = () => frame.evaluate(() => { const e = $world.get('IdentityMenuBarEntry'); e.morphMenuItems().find((i) => i[0] === 'My worlds')[1](); });
    const goHome = () => frame.evaluate(() => { const e = $world.get('IdentityMenuBarEntry'); e.morphMenuItems().find((i) => i[0] === 'My homestar')[1](); });
    const startup = () => frame.evaluate(() => { const s = window.keo.init.startup; return { kind: s.kind, id: s.id, name: s.name }; });

    phase = '1 menu and window';
    const items = await frame.evaluate(() => { const e = $world.get('IdentityMenuBarEntry'); return e ? e.morphMenuItems().map((i) => i[0]) : null; });
    check('menu: wiki pages have no entry of their own; they are made and listed in My worlds', !!items && items.indexOf('My worlds') > 0 && items.indexOf('Wiki pages') === -1, items);
    await openList();
    let win = await until(async () => { const s = await readWin(frame); return s && s.hasList ? s : null; }, 20000);
    check('My worlds opens, and lists no wiki page yet', !!win && win.rows.every((r) => !r.wiki), win);
    await openList();
    await sleep(800);
    check('asking again brings the open window forward, it does not open a second', (await frame.evaluate(() => $world.submorphs.filter((m) => m.name === 'WorldsBrowser').length)) === 1);
    await click(page, await byName(frame, 'createBtn'));
    win = await until(async () => { const s = await readWin(frame); return s && s.all.includes('Create new') ? s : null; }, 10000);
    check('Create offers a Wiki page, and says it stays on this device', !!win && win.all.includes('Wiki page') && win.all.includes('Write a page that stays on this device.') && win.all.includes('Blank world') && win.all.includes('Template'), win && win.all);

    phase = '2 a new page: the world becomes the page';
    // The Create card goes to the wiki's index (keo-wikiindex-ui-test.js); a page's own world is what asking to go to a page by name starts.
    await frame.evaluate(() => { lively.identity.localIdentity.wikiGo({ name: 'Trip notes' }); });
    frame = await waitForWorld(page, 'wiki');
    const st = await startup();
    check('going to a page by name moves to a world of its own, for the page of that name', st.kind === 'wiki' && st.name === 'Trip notes' && st.id === did + '/Trip notes', st);
    let ed = await until(async () => { const r = await readEditor(frame, 'Trip notes'); return r && r.hasView && r.local ? r : null; }, 30000);
    check('New page: the editor opens on this device, named as typed, for the owner to write', !!ed && ed.canEdit === true && ed.objId === did + '/Trip notes', ed);
    check('the page is the world: the editor sits in the world itself, in no window', !!ed && ed.inWorld === true && ed.inWindow === false, ed);
    // A real point inside the editor's text area, asked of the document: what is on top there. (The home page, as the backdrop's neighbour,
    // used to cover it: a click never reached the editor.)
    const top = await frame.evaluate(() => { const e = lively.identity.WikiEditor.localEditors()[0], b = e._pmContainer.getBoundingClientRect(), x = b.x + b.width / 2, y = b.y + Math.min(b.height / 2, 30), hit = document.elementFromPoint(x, y); return { inEditor: !!(hit && hit.closest && hit.closest('.lively-wiki-editor-container')), hit: hit && (hit.className || hit.tagName), bounds: e.getBounds().toString(), world: $world.visibleBounds().toString(), idx: $world.submorphs.indexOf(e), n: $world.submorphs.length }; });
    check('nothing covers the editor: the element on top of a point in its text is its own', top.inEditor === true, top);
    const geo = await fitOf(frame);
    check('it sits below the menu bar and inside the world', fits(geo), geo);
    // The browser window is made smaller and then bigger again: the world tells the page, which keeps filling it (as the home page does).
    await page.setViewportSize({ width: 700, height: 560 });
    const smaller = await until(async () => { const g = await fitOf(frame); return g.worldW === 700 && g.worldH === 560 && fits(g) ? g : null; }, 10000);
    check('when the window is made smaller the page follows: it fits inside it again, narrower and shorter', !!smaller && smaller.w < geo.w && smaller.h < geo.h, smaller || await fitOf(frame));
    await page.setViewportSize({ width: 1280, height: 900 });
    const bigger = await until(async () => { const g = await fitOf(frame); return g.worldW === 1280 && g.worldH === 900 && fits(g) && g.w === geo.w && g.h === geo.h ? g : null; }, 10000);
    check('and when it is made bigger again the page grows back to what it was', !!bigger, bigger || await fitOf(frame));
    check('the menu bar names the world after the page', !!ed && ed.worldName === 'Trip notes', ed && ed.worldName);
    check('the editor has Save and no Close (there is no window) and no History button (history comes later)', !!ed && ed.buttons.includes('Save') && !ed.buttons.includes('Close') && !ed.buttons.includes('History'), ed && ed.buttons);
    const hasRuntime = await frame.evaluate(() => ({ merge: !!(window.Y && typeof window.Y.mergeUpdates === 'function'), pm: !!lively.identity.WikiEditor.localEditors()[0]._ProseMirror() }));
    check('the editor runtime is the one with Y.mergeUpdates', hasRuntime.merge && hasRuntime.pm, hasRuntime);
    check('the page is not in the list until it is saved', (await keoCall(frame, 'wiki.list')).r.length === 0);
    check('the My worlds window belonged to the world that was left: this world has none open', (await frame.evaluate(() => $world.submorphs.filter((m) => m.name === 'WorldsBrowser').length)) === 0);
    // The world around the editor is not saved as a world: it would be a frozen editor with nothing behind it.
    const noSave = await frame.evaluate(() => new Promise((res) => {
      let told = null; const orig = $world.inform; $world.inform = function (m) { told = m; };
      try { $world.saveWorldAs(URL.root.withFilename('Not%20a%20world.html'), false, function (e) { res({ err: e && e.message, told }); }); } finally { $world.inform = orig; }
    }));
    check('saving the world is refused, with a sentence about the wiki page, and nothing is saved as a world', /wiki page/.test(noSave.err || '') && /wiki page/.test(noSave.told || '') && (await keoCall(frame, 'world.list')).r.length === 0, noSave);
    const firstClient = ed && ed.clientId;

    phase = '3 typing and autosave';
    await click(page, await pmRect(frame, 'Trip notes'));
    await page.keyboard.type('Pack the blue bag');
    const saved1 = await until(async () => { const l = await keoCall(frame, 'wiki.list'); return l.ok && l.r.length === 1 && l.r[0].versions >= 1 ? l.r[0] : null; }, 15000);
    check('typing is saved on its own, a couple of seconds later, as the page of this identity', !!saved1 && saved1.name === 'Trip notes' && saved1.mine === true && saved1.id === did + '/Trip notes', saved1 || await readEditor(frame, 'Trip notes'));
    ed = await until(async () => { const r = await readEditor(frame, 'Trip notes'); return r && r.status === 'Saved' ? r : null; }, 8000);
    check('the status says Saved and nothing is waiting to be sent', !!ed && ed.status === 'Saved' && ed.unsaved === 0, ed);
    check('the shell holds the text the person typed', /Pack the blue bag/.test((await shellText(frame, 'Trip notes')) || ''), await shellText(frame, 'Trip notes'));
    // My worlds, opened from inside the page's world (the identity menu): the page is listed, the world was never saved as one.
    await openList();
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.some((r) => r.wiki && r.name === 'Trip notes') ? s : null; }, 20000);
    let row = win && win.rows.find((r) => r.name === 'Trip notes');
    check('My worlds, opened inside the page\'s world, shows the page, labelled Wiki and as yours', !!row && row.wiki && /^Wiki\b/.test(row.meta) && /yours/.test(row.meta) && /change/.test(row.meta), win);
    check('a page row has its own open and no "more" menu (a page cannot be renamed, copied or deleted yet)', !!row && row.hasOpen && !row.hasMore, row);
    check('the window opened above the page (a real click lands on it, not on the editor)', await frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'WorldsBrowser'), e = lively.identity.WikiEditor.localEditors()[0]; return !!w && $world.submorphs.indexOf(w) > $world.submorphs.indexOf(e); }));
    // search: a page is found by its name (the shell searches worlds only; the browser adds the pages whose name holds the words)
    await click(page, await byName(frame, 'searchInput'));
    await page.keyboard.type('trip', { delay: 25 });
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 1 && s.rows[0].wiki ? s : null; }, 8000);
    check('search: the field holds what was typed (the keys went to the search box, not to the page)', !!win && win.query === 'trip', { query: win && win.query, editorText: (await readEditor(frame, 'Trip notes') || {}).text });
    check('search: typing "trip" leaves the page', !!win && win.rows[0].name === 'Trip notes', win);
    await page.keyboard.type(' zzz', { delay: 25 });
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.length === 0 ? s : null; }, 8000);
    check('search: words that are not in the name leave nothing', !!win && /No world matches/.test(win.message || ''), win);
    await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.some((r) => r.name === 'Trip notes') ? s : null; }, 8000);
    check('search: clearing the field brings the page back', !!win && win.rows.some((r) => r.wiki && r.name === 'Trip notes'), win);
    check('the page the person is on is not changed by all this', (await readEditor(frame, 'Trip notes') || {}).text === 'Pack the blue bag', await readEditor(frame, 'Trip notes'));

    phase = '4 leaving with text not yet saved';
    await click(page, await rectOf(frame, () => { const w = $world.submorphs.find((m) => m.name === 'WorldsBrowser'); return w && w.closeButton; }));
    check('the My worlds window closes by its own close control', (await until(async () => (await readWin(frame)) === null, 5000)) === true);
    const v0 = await versionsOf(frame, 'Trip notes');
    await click(page, await pmRect(frame, 'Trip notes'));
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' and the red one');
    const pending = await readEditor(frame, 'Trip notes');
    check('(setup) the new typing has not been sent yet when the person leaves', !!pending && pending.unsaved > 0 && pending.status !== 'Saved', pending);
    await goHome();
    frame = await waitForWorld(page, 'homestar');
    check('the person is on their home page: moving to another page replaced the world', (await startup()).kind === 'homestar');
    const left = await shellText(frame, 'Trip notes');
    check('what was typed in the last moments was saved before the page was left', /Pack the blue bag and the red one/.test(left || '') && (await versionsOf(frame, 'Trip notes')) > v0, left);
    check('the session the page had was given back to the shell when the world was replaced', await (async () => { const a = await keoCall(frame, 'wiki.edit', { session: pending.session, n: 99, update: [1] }); return a.ok === false && /not open for editing/.test(a.e); })());

    phase = '5 open from its row, reload, open again';
    await openList();
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.some((r) => r.wiki && r.name === 'Trip notes') ? s : null; }, 20000);
    check('My worlds, on the home page, lists the page', !!win && win.rows.filter((r) => r.wiki).length === 1, win);
    await click(page, await rowPart(frame, 'Trip notes', 'worldOpen'));
    frame = await waitForWorld(page, 'wiki');
    check('open on the page\'s row moves to its world', (await startup()).id === did + '/Trip notes');
    ed = await until(async () => { const r = await readEditor(frame, 'Trip notes'); return r && r.hasView && r.text ? r : null; }, 30000);
    check('open brings the page back with the text', !!ed && /Pack the blue bag and the red one/.test(ed.text) && ed.inWorld && !ed.inWindow, ed);
    check('the reopened editor was given another client id than the first', !!ed && typeof firstClient === 'number' && ed.clientId !== firstClient && ed.clientId > 0, [firstClient, ed && ed.clientId]);
    await click(page, await pmRect(frame, 'Trip notes'));
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' plus a map');
    const more = await until(async () => { const t = await shellText(frame, 'Trip notes'); return /plus a map/.test(t || '') ? t : null; }, 15000);
    check('writing on after reopening is saved too (a new client id starts its own count)', !!more && /Pack the blue bag and the red one.*plus a map/.test(more), more);
    // A reload of the whole page is the person reloading the tab: the shell remembers the page this tab is on (with the tab's session), so the
    // person is back on it, with its text.
    await page.reload();
    let landed = await landedOn(page);
    const backId = landed.frame ? await landed.frame.evaluate(() => window.keo.init.startup.id || null) : null;
    check('after a reload of the whole page the person is back on the same page', landed.kind === 'wiki' && backId === did + '/Trip notes', { kind: landed.kind, id: backId });
    if (landed.kind !== 'wiki') throw new Error('the reload did not return to the page: nothing after this can be trusted');
    frame = landed.frame;
    ed = await until(async () => { const r = await readEditor(frame, 'Trip notes'); return r && r.hasView && r.text ? r : null; }, 30000);
    check('with its text, in the world, in no window', !!ed && /Pack the blue bag and the red one plus a map/.test(ed.text) && ed.inWorld && !ed.inWindow, ed);
    // Moving to another page forgets it: a reload there lands where it always did (the world saved last, else the home page).
    await goHome();
    frame = await waitForWorld(page, 'homestar');
    await page.reload();
    landed = await landedOn(page);
    check('after moving to the home page a reload lands on the home page, not on the page that was left', landed.kind === 'homestar', landed.kind);
    if (landed.kind !== 'homestar') throw new Error('the reload went back to the page that was left: nothing after this can be trusted');
    frame = landed.frame;
    await openList();
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.some((r) => r.wiki && r.name === 'Trip notes') ? s : null; }, 20000);
    check('after a reload My worlds still lists the page', !!win && win.rows.filter((r) => r.wiki).length === 1, win);
    await click(page, await rowPart(frame, 'Trip notes', 'worldOpen'));
    frame = await waitForWorld(page, 'wiki');
    ed = await until(async () => { const r = await readEditor(frame, 'Trip notes'); return r && r.hasView && r.text ? r : null; }, 30000);
    check('and opening it after the reload gives all the text', !!ed && /Pack the blue bag and the red one plus a map/.test(ed.text), ed);

    phase = '5b a code cell in the page runs';
    // The cell is put in by the editor's own command (the toolbar's Template menu calls it), the code is typed with real keys, and the
    // cell's own Run button is clicked. Scheme runs in a worker of its own (no download).
    await frame.evaluate(() => { const e = lively.identity.WikiEditor.localEditors()[0]; e.editorView.focus(); e._insertCodeCell(e.editorView.state.schema.nodes.code_cell.create({ language: 'scheme' })); });
    await sleep(500);
    await page.keyboard.type('(+ 1 2)');
    const runRect = await rectOf(frame, () => { const e = lively.identity.WikiEditor.localEditors()[0]; return e && e._pmContainer.querySelector('.lively-code-cell-run-btn'); });
    check('(setup) the cell has a Run button', !!runRect, runRect);
    if (runRect) await click(page, runRect);
    const out = await until(async () => frame.evaluate(() => { const e = lively.identity.WikiEditor.localEditors()[0]; const o = e && e._pmContainer.querySelector('.lively-code-cell-output'); const t = o && o.textContent.trim(); return t && t !== 'Run to see output.' ? t : null; }), 30000);
    check('Run runs the code that was typed in the cell and shows its answer', out === '3', out || { header: await frame.evaluate(() => { const e = lively.identity.WikiEditor.localEditors()[0]; const c = e._pmContainer.querySelector('.lively-code-cell'); return c ? c.textContent.slice(0, 160) : 'no cell element'; }), errors: errors.slice(-4) });
    const cellSaved = await until(async () => { const t = await shellText(frame, 'Trip notes'); return /\(\+ 1 2\)/.test(t || '') ? t : null; }, 15000);
    check('the code in the cell is saved with the page, as text', !!cellSaved, await shellText(frame, 'Trip notes'));

    phase = '6 one page per world, and the shell refuses what it does not hold';
    await frame.evaluate(() => { window.__sameWorld = 'yes'; });
    const again = await frame.evaluate((d) => { const E = lively.identity.WikiEditor, a = E.localEditors()[0], b = E.openLocal({ name: 'Trip notes' }), c = E.openLocal({ id: d + '/Trip notes' }), other = E.openLocal({ name: 'A different page' }); return { n: E.localEditors().length, byName: a === b, byId: a === c, other: other }; }, did);
    check('asking for the page that is open again returns it, by name or by id; asking for another page is refused', again.n === 1 && again.byName && again.byId && again.other === null, again);
    const theirs = 'did:keo:' + 'a'.repeat(52) + ':' + 'B'.repeat(43);
    const refusedOther = await keoCall(frame, 'world.go', { kind: 'wiki', id: theirs + '/theirs' });
    check('the shell will not start a world for a page of someone else\'s that this device does not hold', refusedOther.ok === false && /holds no such page/.test(refusedOther.e), refusedOther);
    const refusedNone = await keoCall(frame, 'world.go', { kind: 'wiki' });
    const refusedBlank = await keoCall(frame, 'world.go', { kind: 'wiki', name: '' });
    const refusedId = await keoCall(frame, 'world.go', { kind: 'wiki', id: 'not a page id' });
    check('nor for no page, an empty name or an id that is not a page\'s', refusedNone.ok === false && refusedBlank.ok === false && refusedId.ok === false, [refusedNone, refusedBlank, refusedId]);
    await sleep(1500);
    check('and none of those refusals replaced this world', await stillHere(frame, 'Trip notes'));

    phase = '6b opening the page that is open (a page to a page)';
    // What "open" on a page's row does when it is pressed from inside a page's own world: the world is replaced by a new one for the same page,
    // and what was typed in the last moments is saved first (the same hook as for any other move).
    await frame.evaluate(() => { window.__sameWorld = 'yes'; });
    const clientBefore = (await readEditor(frame, 'Trip notes')).clientId;
    // the page holds a code cell by now (5b), and a click in the middle of it would land in the cell's own editor: focus the page's text
    await frame.evaluate(() => { lively.identity.WikiEditor.localEditors()[0].editorView.focus(); });
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' ++typed just before');
    const typedPending = await readEditor(frame, 'Trip notes');
    check('(setup) the last typing has not been sent when the person opens the page again', !!typedPending && typedPending.unsaved > 0, typedPending);
    await frame.evaluate((d) => { lively.identity.localIdentity.wikiGo({ id: d + '/Trip notes' }); }, did);
    // the frame is new when the old one's marker is gone and a world of kind wiki is up in its place
    let replaced = null;
    for (let i = 0; i < 100 && !replaced; i++) {
      const f = worldFrame(page);
      try { if (f && await f.evaluate(() => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind === 'wiki' && window.__sameWorld === undefined))) replaced = f; } catch (e) { /* the frame is being replaced */ }
      if (!replaced) await sleep(300);
    }
    check('opening the page again replaces the world with a new one for the same page', !!replaced);
    frame = replaced || frame;
    await sleep(2500);
    ed = await until(async () => { const r = await readEditor(frame, 'Trip notes'); return r && r.hasView && r.text ? r : null; }, 30000);
    check('the page comes back with the text typed just before, which was saved first', !!ed && /\+\+typed just before/.test(ed.text) && /\+\+typed just before/.test((await shellText(frame, 'Trip notes')) || ''), ed);
    check('and it has a client id of its own again', !!ed && ed.clientId !== clientBefore && ed.clientId > 0, [clientBefore, ed && ed.clientId]);

    phase = '7 a refused save';
    await frame.evaluate(() => window.__sameWorld = 'yes');
    ed = await until(async () => { const r = await readEditor(frame, 'Trip notes'); return r && r.status === 'Saved' ? r : null; }, 15000);
    const before = await versionsOf(frame, 'Trip notes');
    await frame.evaluate(() => { const e = lively.identity.WikiEditor.localEditors()[0]; e.yDoc.clientID = e.yDoc.clientID + 1; });
    await frame.evaluate(() => { lively.identity.WikiEditor.localEditors()[0].editorView.focus(); });
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' forged');
    const shown = await until(async () => { const r = await readEditor(frame, 'Trip notes'); return r && r.status === 'Not saved' ? r : null; }, 15000);
    check('an edit the shell refuses is shown as "Not saved"', !!shown, await readEditor(frame, 'Trip notes'));
    const msg = await frame.evaluate(() => { let t = ''; (function walk(m) { if (typeof m.textString === 'string' && /was not saved/.test(m.textString)) t = m.textString; (m.submorphs || []).forEach(walk); })($world); return t; });
    check('the reason is told in a message on screen', /The page was not saved: /.test(msg), msg);
    check('and nothing of it is stored', (await versionsOf(frame, 'Trip notes')) === before);
    await goHome();
    await sleep(3000);
    const stayed = await stillHere(frame, 'Trip notes');
    check('leaving while the text cannot be saved does not go: the person stays on the page, with their text', stayed && /forged/.test(((await readEditor(frame, 'Trip notes')) || {}).text || ''), stayed ? await readEditor(frame, 'Trip notes') : 'the world was replaced');
    if (!stayed) throw new Error('the world was replaced while its text could not be saved: nothing after this can be trusted');
    await frame.evaluate(() => { const e = lively.identity.WikiEditor.localEditors()[0]; e._userHasEdited = false; e._unsaved = []; e._unconfirmed = null; });
    await goHome();
    frame = await waitForWorld(page, 'homestar');
    check('once the unsaved text is given up the move goes ahead', (await startup()).kind === 'homestar');

    phase = '8 someone else\'s page, in the editor';
    // The shell would not start a world for this page (step 6), so the editor is asked directly, here in the home page's world (nothing
    // is looked at on screen: the home page covers the backdrop). What the editor does with a page that is not the person's own is the
    // question: it opens it to be read, and says why it cannot be written.
    await frame.evaluate((o) => new Promise((done) => lively.require('lively.identity.WikiEditor').toRun(() => { lively.identity.WikiEditor.openLocal({ id: o + '/theirs' }); done(); })), theirs);
    const ro = await until(async () => { const r = await readEditor(frame, 'theirs'); return r && r.hasView ? r : null; }, 30000);
    check('a page that is not yours opens read-only, and says why', !!ro && ro.canEdit === false && /only the author and the people they listed can edit this page/.test(ro.toolbarLabel), ro);
    check('and it is not made by looking at it', (await keoCall(frame, 'wiki.list')).r.every((p) => p.owner === did));

    phase = '8b many pages, and the order of the one list';
    // The list has no cap of its own (the separate window this replaced showed twelve): thirteen more pages, made through the shell the way
    // the editor does (a page's first save), make fourteen, and the shell and the list agree on all of them. The pages are plain text
    // documents of the shell's own kind: they are only listed here, not opened.
    const madeBad = [];
    for (let i = 1; i <= 13; i++) {
      const nm = 'Extra ' + String(i).padStart(2, '0');
      const o = await keoCall(frame, 'wiki.open', { name: nm });
      if (!o.ok) { madeBad.push(nm + ': ' + o.e); continue; }
      const d = new Y.Doc(); d.clientID = o.r.clientId; d.getText('body').insert(0, nm);
      const s = await keoCall(frame, 'wiki.edit', { session: o.r.session, n: 0, update: Array.from(Y.encodeStateAsUpdate(d)) });
      await keoCall(frame, 'wiki.close', { session: o.r.session });
      if (!s.ok || !s.r || s.r.saved !== true) madeBad.push(nm + ': ' + JSON.stringify(s).slice(0, 140));
    }
    check('(setup) thirteen more pages were saved through the shell', madeBad.length === 0, madeBad);
    const inShell = (await keoCall(frame, 'wiki.list')).r.filter((p) => p.owner === did);
    check('(control) the shell holds fourteen pages of this identity', inShell.length === 14, inShell.length);
    await openList();
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.filter((r) => r.wiki).length === 14 ? s : null; }, 20000);
    const listed = win || await readWin(frame);
    check('the My worlds list shows all fourteen pages (no cap), each as a Wiki row', !!win && win.rows.filter((r) => r.wiki).length === 14 && ['Extra 01', 'Extra 13', 'Trip notes'].every((n) => win.rows.some((r) => r.wiki && r.name === n)), listed && { wikiRows: listed.rows.filter((r) => r.wiki).length, names: listed.rows.map((r) => r.name), message: listed.message, status: listed.status });
    // The order of the one list, on data made for it (a fresh identity has no saved world to put among the pages): the two lists come newest
    // first and are merged without reordering either; while searching the worlds keep their ranking and the pages follow.
    const ord = await frame.evaluate(() => {
      const w = $world.submorphs.find((m) => m.name === 'WorldsBrowser');
      const worlds = [{ name: 'w-new', savedAt: '2026-11-18T10:00:00.000Z' }, { name: 'w-old', savedAt: '2026-11-01T10:00:00.000Z' }];
      const wiki = [{ wiki: true, name: 'p-mid', savedAt: '2026-11-10T10:00:00.000Z' }, { wiki: true, name: 'p-same', savedAt: '2026-11-01T10:00:00.000Z' }, { wiki: true, name: 'p-none', savedAt: null }];
      const names = (l) => l.map((x) => x.name);
      return { merged: names(w._mergeWiki(worlds, wiki, '')), searching: names(w._mergeWiki(worlds, wiki, 'p')), noPages: names(w._mergeWiki(worlds, [], '')) };
    });
    check('the one list is by time, a world before a page of the same time, a page with no time last; worlds are never reordered', JSON.stringify(ord.merged) === JSON.stringify(['w-new', 'p-mid', 'w-old', 'p-same', 'p-none']), ord);
    check('while searching, the worlds keep their ranking and the pages follow; with no pages the worlds are as they were', JSON.stringify(ord.searching) === JSON.stringify(['w-new', 'w-old', 'p-mid', 'p-same', 'p-none']) && JSON.stringify(ord.noPages) === JSON.stringify(['w-new', 'w-old']), ord);

    phase = '9 close My worlds';
    await click(page, await rectOf(frame, () => { const w = $world.submorphs.find((m) => m.name === 'WorldsBrowser'); return w && w.closeButton; }));
    check('the My worlds window closes by its own close control', (await until(async () => (await readWin(frame)) === null, 5000)) === true);

    phase = '10 what a reload remembers, and what ends it';
    // Asked of the shell page directly (the world is not needed): where signing in or a reload would land.
    const where = (sess) => page.evaluate((x) => window.keoShell.landing(x).then((l) => ({ kind: l.kind, id: l.id }), (e) => ({ kind: 'landing failed: ' + e.message })), sess);
    const sess1 = await page.evaluate(() => window.keoIdentity.current());
    await page.evaluate((d) => window.keoIdentity.setPlace({ kind: 'wiki', id: d + '/Trip notes' }), did);
    const toPage = await where(sess1);
    check('landing returns to a remembered page', toPage.kind === 'wiki' && toPage.id === did + '/Trip notes', toPage);
    await page.evaluate((o) => window.keoIdentity.setPlace({ kind: 'wiki', id: o + '/gone' }), theirs);
    const toGone = await where(sess1);
    check('a remembered page that cannot be gone to any more does not lock the person out: landing falls back to the home page', toGone.kind === 'homestar', toGone);
    check('the shell page does not take anything but a wiki page as a place', await page.evaluate(() => window.keoIdentity.setPlace({ kind: 'world', id: 'x' }).then(() => window.keoIdentity.place() === null)));
    await page.evaluate((d) => window.keoIdentity.setPlace({ kind: 'wiki', id: d + '/Trip notes' }), did);
    await page.evaluate(() => window.keoIdentity.signOut());
    check('signing out forgets it: nothing is remembered when nobody is signed in', await page.evaluate(() => window.keoIdentity.place() === null));
    await page.evaluate((d) => window.keoIdentity.signIn({ did: d }), did);
    const sess2 = await page.evaluate(() => window.keoIdentity.current());
    const afterSignIn = await where(sess2);
    check('and after signing in again there is no page to return to: landing is the home page', await page.evaluate(() => window.keoIdentity.place() === null) && afterSignIn.kind === 'homestar', afterSignIn);

    const unload = errors.filter((e) => /Blocked attempt to show a 'beforeunload' confirmation/.test(e));
    if (unload.length) note('the browser blocked ' + unload.length + ' "Leave site?" prompt(s), seen in: ' + unload.map((e) => e.match(/\[([^\]]*)\]/)[1]).join('; ') + ' (a move from one page to another, or the test reloading, before any click)');
    // the runtime logs a refused save as an error, which step 7 causes on purpose: it must be there, and it is the only one allowed
    const refusal = errors.filter((e) => /^console: \[7 a refused save\] The page was not saved: the edit writes with client id \d+, which is not one of this author's/.test(e));
    check('the refused save was logged with the reason the shell gave (and only in that step)', refusal.length >= 1, errors.slice(0, 6));
    const mine = errors.filter((e) => !unload.includes(e) && !refusal.includes(e));
    check('no other page errors or console errors during the run', mine.length === 0, mine.slice(0, 6));
  } catch (e) {
    console.log('FAIL test aborted: ' + (e && e.stack || e));
    console.log('errors seen: ' + JSON.stringify(errors.slice(-8)));
    failed++;
  } finally {
    await ctx.close();
  }
  console.log(failed ? 'FAILED: ' + failed : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
