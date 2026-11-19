// Wiki pages on this device, used the way a person would: a wiki page is a kind of world, so it is made from the "My worlds" window (kernel
// lively.identity.WorldsBrowser): Create, the Wiki page card, a name typed into the runtime's prompt, the editor in a window of its own
// (kernel lively.identity.WikiEditor.openLocal) with real typing, the autosave into the shell's sealed store (shell/keo-wikipages.js), the
// page listed in the same list as the worlds (labelled Wiki, found by search), the window's close control with text not yet saved, the Close
// button, a reload of the whole page, and the page opened again from its row with its text. Also: a refused save is shown and is not stored
// and keeps the window open; a page of someone else opens read-only; one window per page; no separate "Wiki pages" menu entry.
//
// Needs a package whose kernel files are the ones with the local-page seam and the Wiki page card in My worlds.
// Usage: [KEO_HEADLESS=1] node keo-wikipages-ui-test.js <repo root> <package folder> <work dir>
// Headed unless KEO_HEADLESS=1 (the mode is printed first). A headless pass is not a headed pass. NOT covered: a real authenticator, another
// browser, history, sync between devices, embeds, the page in the desktop app, code cells (a separate probe).
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
// The editor of the page called `name` (open on this device), what it is, its text, its state; null when none is open.
const readEditor = (frame, name) => frame.evaluate((n) => {
  const e = (lively.identity.WikiEditor.localEditors ? lively.identity.WikiEditor.localEditors() : []).filter((x) => x._wikiName === n)[0];
  if (!e) return null;
  const pm = e._pmContainer && e._pmContainer.querySelector('.ProseMirror'), win = e.getWindow();
  return { local: !!e._local, name: e._wikiName, objId: e._objId, canEdit: !!e._canEdit, hasView: !!e.editorView, text: pm ? pm.textContent : null, status: e._statusEl ? e._statusEl.textContent : null,
    buttons: e._toolbarDiv ? Array.from(e._toolbarDiv.querySelectorAll('button')).map((b) => b.textContent) : [], toolbarLabel: e._toolbarDiv ? e._toolbarDiv.textContent.slice(-120) : '',
    clientId: e.yDoc ? e.yDoc.clientID : null, session: e._pageSession || null, unsaved: e._unsaved ? e._unsaved.length : null, title: win && win !== e ? win.getTitle() : null, inWindow: !!(win && win !== e) };
}, name);
const pmRect = (frame, name) => rectOf(frame, (n) => { const e = (lively.identity.WikiEditor.localEditors ? lively.identity.WikiEditor.localEditors() : []).filter((x) => x._wikiName === n)[0]; return e && e._pmContainer && e._pmContainer.querySelector('.ProseMirror'); }, name);
const buttonRect = (frame, name, label) => rectOf(frame, ([n, l]) => { const e = (lively.identity.WikiEditor.localEditors ? lively.identity.WikiEditor.localEditors() : []).filter((x) => x._wikiName === n)[0]; return e && Array.from(e._toolbarDiv.querySelectorAll('button')).find((b) => b.textContent === l); }, [name, label]);
const winCloseRect = (frame, name) => rectOf(frame, (n) => { const e = (lively.identity.WikiEditor.localEditors ? lively.identity.WikiEditor.localEditors() : []).filter((x) => x._wikiName === n)[0]; return e && e.getWindow().closeButton; }, name);
const answerPrompt = async (page, frame, text) => {
  await until(() => frame.evaluate(() => !!document.activeElement && document.activeElement !== document.body), 8000);
  await page.keyboard.press('Control+A');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};
const click = async (page, r) => { await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2); };
const textOfState = (arr) => { const d = new Y.Doc(); if (arr && arr.length) Y.applyUpdate(d, Uint8Array.from(arr)); return d.getXmlFragment('prosemirror').toString().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); };
// the text the shell holds for a page, read through a session of the test's own that is closed again
const shellText = async (frame, name) => { const l = await keoCall(frame, 'wiki.open', { name }); if (!l.ok) return null; const t = textOfState(l.r.state); await keoCall(frame, 'wiki.close', { session: l.r.session }); return t; };
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
    const openList = () => frame.evaluate(() => { const e = $world.get('IdentityMenuBarEntry'); e.morphMenuItems().find((i) => i[0] === 'My worlds')[1](); });

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

    phase = '2 new page by real clicks and typing';
    await click(page, await textRect(frame, 'Wiki page'));
    await answerPrompt(page, frame, 'Trip notes');
    let ed = await until(async () => { const r = await readEditor(frame, 'Trip notes'); return r && r.hasView && r.local ? r : null; }, 30000);
    check('New page: the editor opens on this device, named as typed, for the owner to write', !!ed && ed.canEdit === true && ed.objId === did + '/Trip notes', ed);
    check('the page is in a window of its own, titled with its name', !!ed && ed.inWindow && ed.title === 'Trip notes', ed);
    check('the editor has Save and Close and no History button (history comes later)', !!ed && ed.buttons.includes('Save') && ed.buttons.includes('Close') && !ed.buttons.includes('History'), ed && ed.buttons);
    const hasRuntime = await frame.evaluate(() => ({ merge: !!(window.Y && typeof window.Y.mergeUpdates === 'function'), pm: !!(lively.identity.WikiEditor.localEditors ? lively.identity.WikiEditor.localEditors() : [])[0]._ProseMirror() }));
    check('the editor runtime is the one with Y.mergeUpdates', hasRuntime.merge && hasRuntime.pm, hasRuntime);
    check('the page is not in the list until it is saved', (await keoCall(frame, 'wiki.list')).r.length === 0);
    win = await readWin(frame);
    check('the My worlds window went back to the list after the card, and the page is not in it yet', !!win && win.hasList && !win.all.includes('Create new') && win.rows.every((r) => !r.wiki), win);
    const firstClient = ed && ed.clientId;

    phase = '3 typing and autosave';
    await click(page, await pmRect(frame, 'Trip notes'));
    await page.keyboard.type('Pack the blue bag');
    const saved1 = await until(async () => { const l = await keoCall(frame, 'wiki.list'); return l.ok && l.r.length === 1 && l.r[0].versions >= 1 ? l.r[0] : null; }, 15000);
    check('typing is saved on its own, a couple of seconds later, as the page of this identity', !!saved1 && saved1.name === 'Trip notes' && saved1.mine === true && saved1.id === did + '/Trip notes', saved1 || await readEditor(frame, 'Trip notes'));
    ed = await until(async () => { const r = await readEditor(frame, 'Trip notes'); return r && r.status === 'Saved' ? r : null; }, 8000);
    check('the status says Saved and nothing is waiting to be sent', !!ed && ed.status === 'Saved' && ed.unsaved === 0, ed);
    check('the shell holds the text the person typed', /Pack the blue bag/.test((await shellText(frame, 'Trip notes')) || ''), await shellText(frame, 'Trip notes'));
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.some((r) => r.wiki && r.name === 'Trip notes') ? s : null; }, 8000);
    let row = win && win.rows.find((r) => r.name === 'Trip notes');
    check('the open My worlds window now shows the page, labelled Wiki and as yours, without being reopened', !!row && row.wiki && /^Wiki\b/.test(row.meta) && /yours/.test(row.meta) && /change/.test(row.meta), win);
    check('a page row has its own open and no "more" menu (a page cannot be renamed, copied or deleted yet)', !!row && row.hasOpen && !row.hasMore, row);
    // search: a page is found by its name (the shell searches worlds only; the browser adds the pages whose name holds the words)
    // Both windows open at the centre and overlap, and the page's window is in front: a click on My worlds brings it forward first.
    await frame.evaluate(() => { $world.submorphs.find((m) => m.name === 'WorldsBrowser').comeForward(); });
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

    phase = '4 the window\'s close control with text not yet saved';
    const v0 = await versionsOf(frame, 'Trip notes');
    // The search box has the keyboard and its window is in front (both windows open at the centre and overlap): going back to the page is
    // a click on its window, which brings it forward; comeForward is that, then a real click into the text.
    await frame.evaluate(() => { lively.identity.WikiEditor.localEditors().filter((x) => x._wikiName === 'Trip notes')[0].getWindow().comeForward(); });
    await click(page, await pmRect(frame, 'Trip notes'));
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' and the red one');
    const pending = await readEditor(frame, 'Trip notes');
    check('(setup) the new typing has not been sent yet when the window is closed', !!pending && pending.unsaved > 0 && pending.status !== 'Saved', pending);
    await click(page, await winCloseRect(frame, 'Trip notes'));
    const closed1 = await until(async () => (await readEditor(frame, 'Trip notes')) === null, 15000);
    check('the window closes', closed1 === true);
    check('what was typed in the last moments was saved before it closed', /Pack the blue bag and the red one/.test((await shellText(frame, 'Trip notes')) || '') && (await versionsOf(frame, 'Trip notes')) > v0, await shellText(frame, 'Trip notes'));
    check('the session the page had was given back to the shell', (await keoCall(frame, 'wiki.edit', { session: pending.session, n: 99, update: [1] })).e && /not open for editing/.test((await keoCall(frame, 'wiki.edit', { session: pending.session, n: 99, update: [1] })).e));

    phase = '5 reload and reopen';
    await page.reload();
    frame = await waitForWorld(page, 'homestar');
    await openList();
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.some((r) => r.wiki && r.name === 'Trip notes') ? s : null; }, 20000);
    check('after a reload My worlds still lists the page', !!win && win.rows.filter((r) => r.wiki).length === 1, win);
    await click(page, await rowPart(frame, 'Trip notes', 'worldOpen'));
    ed = await until(async () => { const r = await readEditor(frame, 'Trip notes'); return r && r.hasView && r.text ? r : null; }, 30000);
    check('open brings the page back with the text', !!ed && /Pack the blue bag and the red one/.test(ed.text), ed);
    check('the window of the page is in front of the My worlds window that opened it', await frame.evaluate(() => { const d = $world.submorphs.findIndex((m) => m.name === 'WorldsBrowser'); const e = lively.identity.WikiEditor.localEditors().filter((x) => x._wikiName === 'Trip notes')[0]; return d >= 0 && !!e && $world.submorphs.indexOf(e.getWindow()) > d; }));
    check('the reopened editor was given another client id than the first', !!ed && typeof firstClient === 'number' && ed.clientId !== firstClient && ed.clientId > 0, [firstClient, ed && ed.clientId]);
    await click(page, await pmRect(frame, 'Trip notes'));
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' plus a map');
    const more = await until(async () => { const t = await shellText(frame, 'Trip notes'); return /plus a map/.test(t || '') ? t : null; }, 15000);
    check('writing on after the reload is saved too (a new client id starts its own count)', !!more && /Pack the blue bag and the red one.*plus a map/.test(more), more);

    phase = '5b a code cell in the page runs';
    // The cell is put in by the editor's own command (the toolbar's Template menu calls it), the code is typed with real keys, and the
    // cell's own Run button is clicked. Scheme runs in a worker of its own (no download).
    await frame.evaluate(() => { const e = lively.identity.WikiEditor.localEditors().filter((x) => x._wikiName === 'Trip notes')[0]; e.editorView.focus(); e._insertCodeCell(e.editorView.state.schema.nodes.code_cell.create({ language: 'scheme' })); });
    await sleep(500);
    await page.keyboard.type('(+ 1 2)');
    const runRect = await rectOf(frame, () => { const e = lively.identity.WikiEditor.localEditors().filter((x) => x._wikiName === 'Trip notes')[0]; return e && e._pmContainer.querySelector('.lively-code-cell-run-btn'); });
    check('(setup) the cell has a Run button', !!runRect, runRect);
    if (runRect) await click(page, runRect);
    const out = await until(async () => frame.evaluate(() => { const e = lively.identity.WikiEditor.localEditors().filter((x) => x._wikiName === 'Trip notes')[0]; const o = e && e._pmContainer.querySelector('.lively-code-cell-output'); const t = o && o.textContent.trim(); return t && t !== 'Run to see output.' ? t : null; }), 30000);
    check('Run runs the code that was typed in the cell and shows its answer', out === '3', out || { header: await frame.evaluate(() => { const e = lively.identity.WikiEditor.localEditors().filter((x) => x._wikiName === 'Trip notes')[0]; const c = e._pmContainer.querySelector('.lively-code-cell'); return c ? c.textContent.slice(0, 160) : 'no cell element'; }), errors: errors.slice(-4) });
    const cellSaved = await until(async () => { const t = await shellText(frame, 'Trip notes'); return /\(\+ 1 2\)/.test(t || '') ? t : null; }, 15000);
    check('the code in the cell is saved with the page, as text', !!cellSaved, await shellText(frame, 'Trip notes'));

    phase = '6 one window per page, and Close';
    await frame.evaluate(() => { lively.identity.WikiEditor.openLocal({ name: 'Trip notes' }); lively.identity.WikiEditor.openLocal({ id: lively.identity.did.currentUser().did + '/Trip notes' }); });
    await sleep(500);
    check('asking for a page that is open again brings its window forward, by name or by id; it does not open another', (await frame.evaluate(() => (lively.identity.WikiEditor.localEditors ? lively.identity.WikiEditor.localEditors() : []).filter((e) => e._wikiName === 'Trip notes').length)) === 1);
    ed = await until(async () => { const r = await readEditor(frame, 'Trip notes'); return r && r.status === 'Saved' ? r : null; }, 10000);
    const sess = ed && ed.session;
    await click(page, await buttonRect(frame, 'Trip notes', 'Close'));
    check('the Close button closes the window', (await until(async () => (await readEditor(frame, 'Trip notes')) === null, 10000)) === true);
    const stale = await keoCall(frame, 'wiki.edit', { session: sess, n: 99, update: [1] });
    check('and gives the session back', stale.ok === false && /not open for editing/.test(stale.e), stale);

    phase = '7 a refused save';
    await click(page, await rowPart(frame, 'Trip notes', 'worldOpen'));
    ed = await until(async () => { const r = await readEditor(frame, 'Trip notes'); return r && r.hasView && r.text ? r : null; }, 30000);
    const before = await versionsOf(frame, 'Trip notes');
    await frame.evaluate(() => { const e = (lively.identity.WikiEditor.localEditors ? lively.identity.WikiEditor.localEditors() : []).filter((x) => x._wikiName === 'Trip notes')[0]; e.yDoc.clientID = e.yDoc.clientID + 1; });
    await frame.evaluate(() => { lively.identity.WikiEditor.localEditors().filter((x) => x._wikiName === 'Trip notes')[0].editorView.focus(); });
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' forged');
    const shown = await until(async () => { const r = await readEditor(frame, 'Trip notes'); return r && r.status === 'Not saved' ? r : null; }, 15000);
    check('an edit the shell refuses is shown as "Not saved"', !!shown, await readEditor(frame, 'Trip notes'));
    const msg = await frame.evaluate(() => { let t = ''; (function walk(m) { if (typeof m.textString === 'string' && /was not saved/.test(m.textString)) t = m.textString; (m.submorphs || []).forEach(walk); })($world); return t; });
    check('the reason is told in a message on screen', /The page was not saved: /.test(msg), msg);
    check('and nothing of it is stored', (await versionsOf(frame, 'Trip notes')) === before);
    await click(page, await winCloseRect(frame, 'Trip notes'));
    await sleep(1500);
    check('closing the window while the text cannot be saved leaves it open, with its text', !!(await readEditor(frame, 'Trip notes')) && /forged/.test((await readEditor(frame, 'Trip notes')).text), await readEditor(frame, 'Trip notes'));
    await frame.evaluate(() => { const e = (lively.identity.WikiEditor.localEditors ? lively.identity.WikiEditor.localEditors() : []).filter((x) => x._wikiName === 'Trip notes')[0]; e._userHasEdited = false; e._unsaved = []; e._unconfirmed = null; });
    await click(page, await winCloseRect(frame, 'Trip notes'));
    check('once the unsaved text is given up the window closes', (await until(async () => (await readEditor(frame, 'Trip notes')) === null, 10000)) === true);

    phase = '8 someone else\'s page';
    const other = 'did:keo:' + 'a'.repeat(52) + ':' + 'B'.repeat(43);
    await frame.evaluate((o) => { lively.identity.WikiEditor.openLocal({ id: o + '/theirs' }); }, other);
    const ro = await until(async () => { const r = await readEditor(frame, 'theirs'); return r && r.hasView ? r : null; }, 30000);
    check('a page that is not yours opens read-only, in a window titled with its name, and says why', !!ro && ro.canEdit === false && ro.title === 'theirs' && /only the author and the people they listed can edit this page/.test(ro.toolbarLabel), ro);
    check('and it is not made by looking at it', (await keoCall(frame, 'wiki.list')).r.every((p) => p.owner === did));
    await click(page, await winCloseRect(frame, 'theirs'));
    check('its window closes', (await until(async () => (await readEditor(frame, 'theirs')) === null, 10000)) === true);

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
    // These pages were saved through the shell, not by the editor, so nothing told the open list: the editor's own "a page was saved" event does.
    await frame.evaluate(() => window.dispatchEvent(new CustomEvent('keo-wiki-changed')));
    win = await until(async () => { const s = await readWin(frame); return s && s.rows.filter((r) => r.wiki).length === 14 ? s : null; }, 15000);
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
    await frame.evaluate(() => { $world.submorphs.find((m) => m.name === 'WorldsBrowser').comeForward(); });
    await click(page, await rectOf(frame, () => { const w = $world.submorphs.find((m) => m.name === 'WorldsBrowser'); return w && w.closeButton; }));
    check('the My worlds window closes by its own close control', (await until(async () => (await readWin(frame)) === null, 5000)) === true);

    const unload = errors.filter((e) => /Blocked attempt to show a 'beforeunload' confirmation/.test(e));
    if (unload.length) note('the browser blocked ' + unload.length + ' "Leave site?" prompt(s), seen in: ' + unload.map((e) => e.match(/\[([^\]]*)\]/)[1]).join('; ') + ' (the test itself reloading before any click)');
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
