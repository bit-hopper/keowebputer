// Wiki pages on this device, used the way a person would: the identity menu's "Wiki pages" window (kernel lively.identity.WikiPagesDialog),
// New page with a name typed into the runtime's prompt, the editor in a window of its own (kernel lively.identity.WikiEditor.openLocal)
// with real typing, the autosave into the shell's sealed store (shell/keo-wikipages.js), the window's close control with text not yet
// saved, the Close button, a reload of the whole page, and the page opened again from the list with its text. Also: a refused save is shown
// and is not stored and keeps the window open; a page of someone else opens read-only; one window per page.
//
// Needs a package whose kernel files are the ones with the local-page seam (the kernel change that adds WikiPagesDialog.js).
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
const keoCall = (frame, op, args) => frame.evaluate(([o, a]) => window.keo.call(o, a, 60000).then((r) => {
  if (r && r.state) { r.state = Array.from(r.state); }
  return { ok: true, r };
}, (e) => ({ ok: false, e: e.message })), [op, args || {}]);
async function until(fn, ms) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > (ms || 12000)) return v; await sleep(250); } }
// where a morph or node found by `pick` is, in page coordinates (the world sits in an iframe)
async function rectOf(frame, pick, arg) {
  const r = await frame.evaluate(([src, a]) => { const m = (new Function('return (' + src + ')'))()(a); if (!m) return null; const n = m.renderContext ? m.renderContext().shapeNode : m; try { n.scrollIntoView({ block: 'nearest' }); } catch (e) {} const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, [pick.toString(), arg]);
  if (!r) return null;
  const off = await (await frame.frameElement()).boundingBox();
  return { x: off.x + r.x, y: off.y + r.y, w: r.w, h: r.h };
}
const partRect = (frame, name) => rectOf(frame, (n) => { const w = $world.submorphs.find((m) => m.name === 'IdentityWikiPagesDialog'); return w && w.get('wikiPagesContent').submorphs.find((m) => m.name === n); }, name);
const readDlg = (frame) => frame.evaluate(() => {
  const w = $world.submorphs.find((m) => m.name === 'IdentityWikiPagesDialog');
  if (!w) return null;
  const c = w.get('wikiPagesContent'), t = (n) => { const m = c.submorphs.find((x) => x.name === n); return m ? String(m.textString) : null; };
  const rows = c.submorphs.filter((m) => m.name === 'pageName').map((m) => ({ name: String(m.textString), id: m.pageId, info: String((c.submorphs.find((x) => x.name === 'pageInfo' && x.pageId === m.pageId) || {}).textString) }));
  return { rows, empty: t('emptyText'), intro: t('introText'), status: t('statusText'), buttons: c.submorphs.filter((m) => m instanceof lively.morphic.Button).map((b) => b.name) };
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
    const openList = () => frame.evaluate(() => { const e = $world.get('IdentityMenuBarEntry'); e.morphMenuItems().find((i) => i[0] === 'Wiki pages')[1](); });

    phase = '1 menu and window';
    const items = await frame.evaluate(() => { const e = $world.get('IdentityMenuBarEntry'); return e ? e.morphMenuItems().map((i) => i[0]) : null; });
    check('menu: "Wiki pages" is offered, right after "My files"', items && items.indexOf('Wiki pages') === items.indexOf('My files') + 1 && items.indexOf('Wiki pages') > 0, items);
    await openList();
    let dlg = await until(async () => { const d = await readDlg(frame); return d && d.empty ? d : null; }, 20000);
    check('window: it opens and says there are no pages yet', !!dlg && /No pages yet/.test(dlg.empty), dlg);
    check('window: it has New page and Close', !!dlg && dlg.buttons.includes('newBtn') && dlg.buttons.includes('closeBtn'), dlg);
    await openList();
    await sleep(800);
    check('window: asking again brings the open one forward, it does not open a second', (await frame.evaluate(() => $world.submorphs.filter((m) => m.name === 'IdentityWikiPagesDialog').length)) === 1);

    phase = '2 new page by real clicks and typing';
    await click(page, await partRect(frame, 'newBtn'));
    await answerPrompt(page, frame, 'Trip notes');
    let ed = await until(async () => { const r = await readEditor(frame, 'Trip notes'); return r && r.hasView && r.local ? r : null; }, 30000);
    check('New page: the editor opens on this device, named as typed, for the owner to write', !!ed && ed.canEdit === true && ed.objId === did + '/Trip notes', ed);
    check('the page is in a window of its own, titled with its name', !!ed && ed.inWindow && ed.title === 'Trip notes', ed);
    check('the editor has Save and Close and no History button (history comes later)', !!ed && ed.buttons.includes('Save') && ed.buttons.includes('Close') && !ed.buttons.includes('History'), ed && ed.buttons);
    const hasRuntime = await frame.evaluate(() => ({ merge: !!(window.Y && typeof window.Y.mergeUpdates === 'function'), pm: !!(lively.identity.WikiEditor.localEditors ? lively.identity.WikiEditor.localEditors() : [])[0]._ProseMirror() }));
    check('the editor runtime is the one with Y.mergeUpdates', hasRuntime.merge && hasRuntime.pm, hasRuntime);
    check('the page is not in the list until it is saved', (await keoCall(frame, 'wiki.list')).r.length === 0);
    const firstClient = ed && ed.clientId;

    phase = '3 typing and autosave';
    await click(page, await pmRect(frame, 'Trip notes'));
    await page.keyboard.type('Pack the blue bag');
    const saved1 = await until(async () => { const l = await keoCall(frame, 'wiki.list'); return l.ok && l.r.length === 1 && l.r[0].versions >= 1 ? l.r[0] : null; }, 15000);
    check('typing is saved on its own, a couple of seconds later, as the page of this identity', !!saved1 && saved1.name === 'Trip notes' && saved1.mine === true && saved1.id === did + '/Trip notes', saved1 || await readEditor(frame, 'Trip notes'));
    ed = await until(async () => { const r = await readEditor(frame, 'Trip notes'); return r && r.status === 'Saved' ? r : null; }, 8000);
    check('the status says Saved and nothing is waiting to be sent', !!ed && ed.status === 'Saved' && ed.unsaved === 0, ed);
    check('the shell holds the text the person typed', /Pack the blue bag/.test((await shellText(frame, 'Trip notes')) || ''), await shellText(frame, 'Trip notes'));
    dlg = await until(async () => { const d = await readDlg(frame); return d && d.rows.length === 1 ? d : null; }, 8000);
    check('the open list window now shows the page, as yours, without being reopened', !!dlg && dlg.rows[0].name === 'Trip notes' && /yours/.test(dlg.rows[0].info), dlg);

    phase = '4 the window\'s close control with text not yet saved';
    const v0 = await versionsOf(frame, 'Trip notes');
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
    await frame.evaluate(() => { const e = $world.get('IdentityMenuBarEntry'); e.morphMenuItems().find((i) => i[0] === 'Wiki pages')[1](); });
    dlg = await until(async () => { const d = await readDlg(frame); return d && d.rows.length === 1 ? d : null; }, 20000);
    check('after a reload the list still has the page', !!dlg && dlg.rows[0].name === 'Trip notes', dlg);
    await click(page, await partRect(frame, 'openBtn'));
    ed = await until(async () => { const r = await readEditor(frame, 'Trip notes'); return r && r.hasView && r.text ? r : null; }, 30000);
    check('Open brings the page back with the text', !!ed && /Pack the blue bag and the red one/.test(ed.text), ed);
    check('the window of the page is in front of the list window that opened it', await frame.evaluate(() => { const d = $world.submorphs.findIndex((m) => m.name === 'IdentityWikiPagesDialog'); const e = lively.identity.WikiEditor.localEditors().filter((x) => x._wikiName === 'Trip notes')[0]; return d >= 0 && !!e && $world.submorphs.indexOf(e.getWindow()) > d; }));
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
    await click(page, await partRect(frame, 'openBtn'));
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

    phase = '9 close the list window';
    await click(page, await partRect(frame, 'closeBtn'));
    check('the list window closes', (await until(async () => (await readDlg(frame)) === null, 5000)) === true);

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
