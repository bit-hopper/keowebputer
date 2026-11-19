// The person's wiki on this device, used the way a person would: the INDEX of their pages (kernel lively.identity.WikiIndex, local scope), a
// world of its own that the shell starts (start kind 'wikiindex', world/keo-boot.js), as the host's own page for a wiki is. Reached from My
// worlds (Create, Wiki page: it goes to the index and asks for the new-page dialog, as the host's card hands off with "?new=1") and, from a
// page's own world, by clicking the world's name in the menu bar. Cards (name, "Updated <date>"), the sort menu, the left list, the search
// box, the right panel of categories and tags, a page opened INSIDE the index in the slot below the cards (its editor, saving as the person
// types), the New wiki page dialog (name, category, tags), the back pill to the home page, leaving with typing not yet saved, and a reload
// that comes back to the index with the same page open. Real mouse clicks and real keys; what the index holds is read from the live
// controller (lively.identity.WikiIndex.current) and what the shell holds is read through the shell's own page operations.
//
// Needs a package whose kernel files are the ones with WikiIndex.openLocal, LocalIdentity.wikiIndexGo/wikiHere and the slot mode of
// WikiEditor.openLocal.
// Usage: [KEO_HEADLESS=1] node keo-wikiindex-ui-test.js <repo root> <package folder> <work dir>
// Headed unless KEO_HEADLESS=1 (the mode is printed first). A headless pass is not a headed pass. NOT covered: a real authenticator, another
// browser, the desktop app, search inside the text of pages, the read-only view, history, deleting or renaming a page, sync.
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
// The same, but it answers null when no world of that kind came up in ms, so that a move that did not happen fails the check that names it.
async function tryWorld(page, kind, ms) {
  const t = Date.now();
  while (Date.now() - t < (ms || 20000)) {
    const frame = worldFrame(page);
    if (frame) { try { if (await frame.evaluate((k) => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind === k), kind)) { await sleep(2500); return frame; } } catch (e) { /* not ready */ } }
    await sleep(300);
  }
  return null;
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
async function until(fn, ms) { const t = Date.now(); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() - t > (ms || 12000)) return v; await sleep(250); } }
// where a morph or node found by `pick` is, in page coordinates (the world sits in an iframe)
async function rectOf(frame, pick, arg) {
  const r = await frame.evaluate(([src, a]) => { const m = (new Function('return (' + src + ')'))()(a); if (!m) return null; const n = m.renderContext ? m.renderContext().shapeNode : m; try { n.scrollIntoView({ block: 'nearest' }); } catch (e) {} const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, [pick.toString(), arg]);
  if (!r) return null;
  const off = await (await frame.frameElement()).boundingBox();
  return { x: off.x + r.x, y: off.y + r.y, w: r.w, h: r.h };
}
const click = async (page, r, what) => { if (!r) throw new Error('nothing to click: ' + (what || '?')); await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2); };
// A Text anywhere in the world whose string is exactly `s` (and is on screen), by its place.
const textRect = (frame, s) => rectOf(frame, (str) => { let hit = null; (function walk(m) { if (hit) return; if (typeof m.textString === 'string' && m.textString.trim() === str && m.renderContext && m.renderContext().shapeNode && m.renderContext().shapeNode.getBoundingClientRect().width > 0) hit = m; (m.submorphs || []).forEach(walk); })($world); return hit; }, s);
const byName = (frame, name) => rectOf(frame, (n) => { const w = $world.submorphs.find((m) => m.name === 'WorldsBrowser'); return w && w.get(n); }, name);

// What the index holds and shows, read from the live controller: its title, the cards in order (name, the date line), the left list, the
// right panel, the sort, the page that is open, and what the world says in the status line.
const readIndex = (frame) => frame.evaluate(() => {
  const I = lively.identity.WikiIndex && lively.identity.WikiIndex.current;
  if (!I || !I._titleLabel) return null;
  const txt = (m) => (m && typeof m.textString === 'string' ? m.textString : null);
  const cards = (I._cardMorphs || []).map((c) => ({ name: txt(c._nameLabel), date: txt(c._dateLabel), text: txt(c) }));
  const left = (I._sidebarBox && I._sidebarBox._itemMorphs || []).map(txt).filter((x) => x !== null);
  const panel = (I._categoriesPanel && I._categoriesPanel._itemMorphs || []).map((m) => txt(m) !== null ? { text: txt(m) } : { pill: (m.submorphs[0] && txt(m.submorphs[0])) || null, fill: String(m.getFill && m.getFill()) });
  const a = I._activeContentMorph;
  return { title: txt(I._titleLabel), kind: I._scope && I._scope.kind, cards, left, leftHeader: txt(I._sidebarHeader), panel, sort: I._sortBy, sortLabel: txt(I._sortByLabel),
    open: a ? { name: a._wikiName, local: !!a._local, inIndex: !!a._inIndex, inWorld: a.owner === $world, hasView: !!a.editorView, canEdit: !!a._canEdit, status: a._statusEl ? a._statusEl.textContent : null,
      text: a._pmContainer && a._pmContainer.querySelector('.ProseMirror') ? a._pmContainer.querySelector('.ProseMirror').textContent : null, unsaved: a._unsaved ? a._unsaved.length : null, session: a._pageSession || null } : null,
    editors: lively.identity.WikiEditor.localEditors().length, pagesHeld: (I._pages || []).map((p) => p.wikiName), categoryFilter: I._categoryFilter, tagFilter: I._tagFilter,
    canWrite: !!I._canWrite, newBtnVisible: I._newBtn ? I._newBtn.isVisible() : null, dialog: !!($world.newWikiPageDialog && $world.newWikiPageDialog.world && $world.newWikiPageDialog.world()),
    searchDropdown: I._searchDropdown ? (() => { const out = []; (function walk(m) { if (txt(m) !== null && txt(m) !== '') out.push(txt(m)); (m.submorphs || []).forEach(walk); })(I._searchDropdown); return out; })() : null };
});
const cardNames = async (frame) => ((await readIndex(frame)) || { cards: [] }).cards.map((c) => c.name);
// a morph of the controller, by a function over the controller, as a click target
const ctl = (frame, pick, arg) => rectOf(frame, (a) => { const I = lively.identity.WikiIndex.current; return (new Function('return (' + a[0] + ')'))()(I, a[1]); }, [pick.toString(), arg === undefined ? null : arg]);
const cardRect = (frame, name) => ctl(frame, (I, n) => I._cardMorphs.find((c) => c._nameLabel && c._nameLabel.textString === n), name);
const leftRect = (frame, name) => ctl(frame, (I, n) => I._sidebarBox._itemMorphs.find((m) => m.textString === n), name);
const panelRect = (frame, text) => ctl(frame, (I, t) => I._categoriesPanel._itemMorphs.find((m) => m.textString === t || (m.submorphs && m.submorphs[0] && m.submorphs[0].textString === t)), text);
const pmRect = (frame) => rectOf(frame, () => { const e = lively.identity.WikiEditor.localEditors()[0]; return e && e._pmContainer && e._pmContainer.querySelector('.ProseMirror'); });
// what the shell holds: the list of pages, through the shell page's own operations (no bridge); and the text of one page
const shellList = (page) => page.evaluate(() => window.keoWiki.pages().list());
const textOfState = (u) => { const d = new Y.Doc(); if (u && u.length) Y.applyUpdate(d, Uint8Array.from(u)); return d.getXmlFragment('prosemirror').toString().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); };
const shellText = (page, name) => page.evaluate(async (n) => { const P = window.keoWiki.pages(), o = await P.open({ name: n }), s = Array.from(o.state); await P.close({ session: o.session }); return s; }, name).then(textOfState);
const place = (page) => page.evaluate(() => window.keoIdentity.place());
// Words said in the world (the runtime's own status line and inform boxes) since `mark()` was called in the frame
const installTell = (frame) => frame.evaluate(() => { window.__told = []; if (!window.__tellPatched) { window.__tellPatched = true; const i = $world.inform, s = $world.setStatusMessage; $world.inform = function (m) { window.__told.push(String(m)); return i.apply(this, arguments); }; $world.setStatusMessage = function (m) { window.__told.push(String(m)); return s.apply(this, arguments); }; } });
const told = (frame) => frame.evaluate(() => window.__told || []);

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const profile = path.join(WORK, 'profile-wikiindex-' + process.pid);
  const ctx = await chromium.launchPersistentContext(profile, Object.assign({ headless, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] }, headless ? { channel: 'chromium' } : {}));
  console.log('MODE ' + (headless ? 'HEADLESS (newer headless mode, channel chromium)' : 'headed') + '; browser ' + (ctx.browser() ? ctx.browser().version() : 'unknown') + '; package ' + path.basename(EXT));
  await sleep(2500);
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('PAGEERROR [' + phase + '] ' + e.message.slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure|ERR_FILE_NOT_FOUND|youtube\.com|Geolocation/.test(m.text())) errors.push('console: [' + phase + '] ' + m.text().slice(0, 200)); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });

    await page.goto(`chrome-extension://${ID}/start.html`);
    let frame = await waitForWorld(page, 'gate');
    await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }));
    await frame.evaluate(() => window.keo.call('world.go', { kind: 'enter' }, 60000)).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    const did = await page.evaluate(() => window.keoIdentity.current().then((s) => s.did));
    const startup = () => frame.evaluate(() => { const s = window.keo.init.startup; return { kind: s.kind, open: s.open === undefined ? null : s.open, newPage: s.newPage === true, id: s.id, name: s.name }; });
    const openList = () => frame.evaluate(() => { const e = $world.get('IdentityMenuBarEntry'); e.morphMenuItems().find((i) => i[0] === 'My worlds')[1](); });
    // The New wiki page dialog, by real clicks and keys: a title, a category from its popup, tags, Create.
    const dialogPart = (name) => rectOf(frame, (n) => { const d = $world.newWikiPageDialog; return d && d.get(n); }, name);
    const fillDialog = async (title, category, tags) => {
      await until(async () => (await readIndex(frame)).dialog, 10000);
      await click(page, await dialogPart('TitleText'), 'title field');
      await page.keyboard.type(title, { delay: 15 });
      if (category) {
        const trig = await dialogPart('CategoryTrigger');
        await click(page, trig, 'category trigger');
        const row = await until(() => rectOf(frame, (c) => { const d = $world.newWikiPageDialog, p = d && d.get('NewWikiPageDialogPane') && d.get('NewWikiPageDialogPane')._categoryPopup; return p && p.submorphs.find((m) => m.textString === c); }, category), 4000);
        if (!row) {
          // say what the page looked like, so the failure names its cause
          const why = await frame.evaluate(([x, y]) => { const d = $world.newWikiPageDialog, hit = document.elementFromPoint(x, y); return { dialogInWorld: !!(d && d.world()), title: d ? String(d.get('TitleText').textString) : null, popup: !!(d && d.get('NewWikiPageDialogPane')._categoryPopup), scrollY: window.pageYOffset, hit: hit && String(hit.className || hit.tagName).slice(0, 60), told: window.__told }; }, [trig.x + trig.w / 2 - (await (await frame.frameElement()).boundingBox()).x, trig.y + trig.h / 2 - (await (await frame.frameElement()).boundingBox()).y]);
          throw new Error('the category popup did not open: ' + JSON.stringify(why));
        }
        await click(page, row, 'category ' + category);
      }
      if (tags) { await click(page, await dialogPart('TagsText'), 'tags field'); await page.keyboard.type(tags, { delay: 15 }); }
      await click(page, await dialogPart('CreateButton'), 'Create');
    };
    // Type into the open page's text with real keys, then wait until the shell holds it
    const typeInPage = async (text) => { await click(page, await pmRect(frame), 'the page text'); await page.keyboard.press('Control+End'); await page.keyboard.type(text, { delay: 8 }); };
    // The "+ New wiki page" pill, by a real click, and the dialog it must open (a failure to open it ends the run with that said: nothing after it can be trusted)
    const openNewDialog = async () => {
      await click(page, await ctl(frame, (I) => I._newBtn), '+ New wiki page');
      const up = await until(async () => (await readIndex(frame)).dialog, 10000);
      if (!up) throw new Error('the New wiki page dialog did not open when the pill was clicked');
    };
    // A message the runtime shows (an inform box) is read, then dismissed by its Ok button, as a person would; the pill is not reachable under it
    const dismissMessage = async (needle) => {
      const ok = await until(() => textRect(frame, 'Ok'), 6000);
      if (!ok) throw new Error('no Ok button to dismiss the message (' + needle + ')');
      await click(page, ok, 'Ok of the message');
      return !!(await until(async () => (await textRect(frame, needle)) === null, 6000));
    };
    const waitSaved = (name, needle) => until(async () => { const t = await shellText(page, name); return needle.test(t) ? t : null; }, 20000);

    phase = '1 Create > Wiki page goes to the index';
    await openList();
    await until(async () => frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'WorldsBrowser'); return !!(w && w.get('worldsList')); }), 20000);
    await click(page, await byName(frame, 'createBtn'), 'Create button of My worlds');
    await until(async () => textRect(frame, 'Wiki page'), 10000);
    await click(page, await textRect(frame, 'Wiki page'), 'the Wiki page card');
    frame = await waitForWorld(page, 'wikiindex');
    await installTell(frame);
    const st = await startup();
    check('Create > Wiki page moves to a world of its own that starts as the wiki index, asking for the new-page dialog', st.kind === 'wikiindex' && st.newPage === true && st.open === null, st);
    let ix = await until(async () => { const r = await readIndex(frame); return r && r.kind === 'local' ? r : null; }, 30000);
    check('the index is up in the local scope, titled after the identity\'s label, with nothing yet', !!ix && ix.title === 'Maya wiki' && ix.pagesHeld.length === 0 && ix.canWrite === true, ix);
    check('the empty index says so in the grid, the left list and the right panel', !!ix && ix.cards.length === 1 && /No wiki pages yet/.test(ix.cards[0].text) && ix.left.some((t) => /No wiki pages yet/.test(t)) && ix.leftHeader === 'ALL WIKI PAGES' && ix.panel.some((p) => /No categories yet/.test(p.text || '')), ix);
    check('the new-page dialog was asked for at once (the host\'s "?new=1")', !!ix && ix.dialog === true, ix && ix.dialog);
    const bar = await frame.evaluate(() => { const b = $world.get(/^MenuBar/), e = b && b.submorphs.find((m) => m.name === 'WorldNameMenuBarEntry'); return e ? { text: String(e.textString), tip: e.toolTip } : null; });
    check('the menu bar names the world after the wiki, and says a click goes back to the home page', !!bar && bar.text === 'Maya wiki' && /back to your homestar/.test(bar.tip || ''), bar);
    const noSave = await frame.evaluate(() => new Promise((res) => {
      let said = null; const orig = $world.inform; $world.inform = function (m) { said = m; };
      try { $world.saveWorldAs(URL.root.withFilename('Not%20a%20world.html'), false, function (e) { res({ err: e && e.message, said }); }); } finally { $world.inform = orig; }
    }));
    check('saving the world is refused with a sentence about the wiki, and no world is saved', /wiki/.test(noSave.err || '') && /wiki/.test(noSave.said || ''), noSave);

    phase = '2 a first page, made through the dialog';
    await fillDialog('Paris Trip', 'Place', 'France, Europe');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.hasView ? r : null; }, 30000);
    check('Create closes the dialog and opens the new page in the index\'s slot, named by its title', !!ix && ix.dialog === false && ix.open.name === 'paris-trip' && ix.open.local && ix.open.inIndex && ix.open.inWorld && ix.open.canEdit, ix);
    check('exactly one editor is in the world', !!ix && ix.editors === 1, ix && ix.editors);
    check('while a page is open the left panel is that page\'s outline', !!ix && ix.leftHeader === 'ON THIS PAGE', ix && ix.leftHeader);
    let pl = await place(page);
    check('the shell was told which page the index shows, by the page\'s id', !!pl && pl.kind === 'wikiindex' && pl.id === did + '/paris-trip', pl);
    const geo0 = await frame.evaluate(() => { const e = lively.identity.WikiEditor.localEditors()[0], b = e.getBounds(), I = lively.identity.WikiIndex.current; return { top: b.y, gridBottom: I._gridY + (I._gridContentHeight || 0), w: b.width, h: b.height }; });
    check('the page sits below the cards, at a real size', geo0.top >= geo0.gridBottom && geo0.w > 400 && geo0.h > 200, geo0);
    // nothing covers the editor: what is on top at a point in its text is its own
    const top = await frame.evaluate(() => { const e = lively.identity.WikiEditor.localEditors()[0]; e._pmContainer.scrollIntoView({ block: 'nearest' }); const b = e._pmContainer.getBoundingClientRect(), hit = document.elementFromPoint(b.x + b.width / 2, b.y + Math.min(30, b.height / 2)); return !!(hit && hit.closest && hit.closest('.lively-wiki-editor-container')); });
    check('nothing covers the editor: the element on top of a point in its text is its own', top === true);
    await typeInPage('Rome is not Paris');
    const saved1 = await until(async () => { const l = await shellList(page); const p = l.filter((x) => x.name === 'paris-trip')[0]; return p && p.versions >= 1 && p.category ? p : null; }, 25000);
    check('typing is saved on its own, and the shell lists the page with the category and tags chosen in the dialog', !!saved1 && saved1.category === 'Place' && JSON.stringify(saved1.tags) === JSON.stringify(['France', 'Europe']) && saved1.mine === true, saved1 || await shellList(page));
    check('and with when it was created', !!saved1 && /^\d{4}-\d\d-\d\dT/.test(saved1.created || ''), saved1);
    check('the shell holds the typed text', /Rome is not Paris/.test((await shellText(page, 'paris-trip')) || ''), await shellText(page, 'paris-trip'));
    ix = await until(async () => { const r = await readIndex(frame); return r && r.cards.some((c) => c.name === 'paris-trip') ? r : null; }, 15000);
    check('the page appears as a card without a reload, with its date line', !!ix && ix.cards.length === 1 && /^Updated \d/.test(ix.cards[0].date || ''), ix && ix.cards);
    check('the right panel shows the category with its count and the tags under it', !!ix && ix.panel.some((p) => p.text === 'Place (1)') && ix.panel.some((p) => p.pill === 'France') && ix.panel.some((p) => p.pill === 'Europe'), ix && ix.panel);
    // a heading typed into the page shows in "On this page" (the index watches the editor: nothing waits on a timer)
    await frame.evaluate(() => { const e = lively.identity.WikiEditor.localEditors()[0], v = e.editorView, s = v.state.schema; v.focus(); v.dispatch(v.state.tr.replaceSelectionWith(s.nodes.heading.create({ level: 2 }, s.text('Where we stay')))); });
    const outline = await until(async () => { const r = await readIndex(frame); return r && r.left.includes('Where we stay') ? r : null; }, 8000);
    check('a heading in the page appears in the left panel, "On this page"', !!outline, (await readIndex(frame) || {}).left);

    phase = '3 more pages: the + button, a name taken, the dialog';
    await frame.evaluate(() => { window.__sameWorld = 'yes'; });
    await openNewDialog();
    ix = await readIndex(frame);
    check('the "+ New wiki page" pill opens the dialog, and the page that is open stays until a new one is made', !!ix && ix.dialog && ix.open && ix.open.name === 'paris-trip', ix);
    await fillDialog('Paris Trip', 'Place', '');
    const dupTold = await until(async () => { const t = await told(frame); return t.find((m) => /already have a page named/.test(m)) || null; }, 8000);
    check('a name the person already has is not made again: they are told, and the open page stays', !!dupTold && (await readIndex(frame)).open.name === 'paris-trip' && (await readIndex(frame)).editors === 1, dupTold);
    check('(setup) the message is dismissed by its Ok button', await dismissMessage('You already have a page named “paris-trip”. Open it from the list, or choose another name.'));
    await openNewDialog();
    await fillDialog('Rome', 'Place', '');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'rome' && r.open.hasView ? r : null; }, 30000);
    check('a second page replaces the first in the slot: one editor, the old one given back', !!ix && ix.editors === 1, ix);
    await typeInPage('The Colosseum');
    await waitSaved('rome', /Colosseum/);
    await openNewDialog();
    await fillDialog('Meeting Notes', 'Concept', 'work');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'meeting-notes' && r.open.hasView ? r : null; }, 30000);
    await typeInPage('Agenda: budget');
    await waitSaved('meeting-notes', /budget/);
    ix = await until(async () => { const r = await readIndex(frame); return r && r.cards.length === 3 && r.panel.some((p) => p.text === 'Concept (1)') ? r : null; }, 15000);
    check('three pages: three cards, and the panel groups them by category with counts', !!ix && ix.panel.some((p) => p.text === 'Place (2)') && ix.panel.some((p) => p.text === 'Concept (1)') && ix.panel.some((p) => p.pill === 'work'), ix && ix.panel);
    const rows = await shellList(page);
    check('(control) the shell agrees: three pages, their categories and tags', rows.length === 3 && rows.find((r) => r.name === 'rome').category === 'Place' && rows.find((r) => r.name === 'rome').tags.length === 0 && rows.find((r) => r.name === 'meeting-notes').category === 'Concept' && JSON.stringify(rows.find((r) => r.name === 'meeting-notes').tags) === '["work"]', rows.map((r) => [r.name, r.category, r.tags]));
    check('the old pages were given back to the shell as the slot moved on: only the open page has a session', await (async () => { const r = await readIndex(frame); return !!r && r.editors === 1; })());

    phase = '4 sort';
    const order = async () => (await cardNames(frame)).join(',');
    const pick = async (label) => {
      await click(page, await ctl(frame, (I) => I._sortByBox), 'sort button');
      await click(page, await rectOf(frame, (l) => { const I = lively.identity.WikiIndex.current, d = I._sortByDropdown; return d && d.submorphs.find((m) => typeof m.textString === 'string' && m.textString.trim().replace(/^✓\s*/, '') === l); }, label), 'sort ' + label);
      await sleep(600);
    };
    check('the default order is last modified, newest first', (await readIndex(frame)).sortLabel === 'last modified' && await order() === 'meeting-notes,rome,paris-trip', await order());
    await pick('alphabetical');
    check('alphabetical puts the cards in name order', await order() === 'meeting-notes,paris-trip,rome' && (await readIndex(frame)).sortLabel === 'alphabetical', await order());
    await pick('last created');
    check('last created puts the newest-made page first', await order() === 'meeting-notes,rome,paris-trip', await order());
    await pick('last modified');
    check('back to last modified', await order() === 'meeting-notes,rome,paris-trip', await order());
    // the menu has one more row while a page is open: "All pages"
    await click(page, await ctl(frame, (I) => I._sortByBox), 'sort button');
    const rowsMenu = await frame.evaluate(() => { const I = lively.identity.WikiIndex.current, d = I._sortByDropdown; return d ? d.submorphs.map((m) => typeof m.textString === 'string' ? m.textString.trim() : null).filter(Boolean) : null; });
    check('while a page is open the sort menu has "All pages" under the three orders', !!rowsMenu && rowsMenu.length === 4 && rowsMenu[3] === 'All pages', rowsMenu);
    await click(page, await rectOf(frame, () => { const I = lively.identity.WikiIndex.current; return I._sortByDropdown.submorphs.find((m) => typeof m.textString === 'string' && m.textString.trim() === 'All pages'); }), 'All pages');
    ix = await until(async () => { const r = await readIndex(frame); return r && !r.open ? r : null; }, 10000);
    check('"All pages" closes the open page: no editor, the cards use the whole width, the left panel lists every page', !!ix && ix.editors === 0 && ix.leftHeader === 'ALL WIKI PAGES' && ['meeting-notes', 'paris-trip', 'rome'].every((n) => ix.left.includes(n)), ix);
    pl = await place(page);
    check('and the shell is told the index shows no page now', !!pl && pl.kind === 'wikiindex' && pl.id === null, pl);

    phase = '5 opening pages: a card, the left list, the home button';
    await click(page, await cardRect(frame, 'rome'), 'card rome');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'rome' && r.open.hasView && /Colosseum/.test(r.open.text || '') ? r : null; }, 30000);
    check('a click on a card opens that page in the slot, with its text', !!ix && ix.open.inIndex && ix.editors === 1, ix);
    await click(page, await ctl(frame, (I) => I._sidebarHomeBtn), 'home button of the left panel');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.leftHeader === 'ALL WIKI PAGES' ? r : null; }, 6000);
    check('the left panel\'s home button switches it to the list of every page, with a page still open', !!ix && ix.open && ix.open.name === 'rome' && ix.left.includes('paris-trip'), ix);
    const sessionBefore = ix && ix.open && ix.open.session;
    await click(page, await leftRect(frame, 'paris-trip'), 'paris-trip in the left list');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'paris-trip' && r.open.hasView && /Rome is not Paris/.test(r.open.text || '') ? r : null; }, 30000);
    check('a page in the left list opens in the slot, in place of the one that was open, with its text', !!ix && ix.editors === 1 && ix.open.inIndex, ix);
    const closedSession = await page.evaluate(async (s) => { try { await window.keoWiki.pages().edit({ session: s, n: 99, update: new Uint8Array([1]) }); return 'accepted'; } catch (e) { return e.message; } }, sessionBefore);
    check('the shell session of the page that was left was given back', /not open for editing/.test(closedSession), closedSession);

    phase = '5b the window is made smaller and bigger';
    // The page in the slot is placed and sized by the index (below the cards, between the panels), not fitted to the whole world as a page
    // that is a world of its own is: when the window changes size it must still sit where the index puts it.
    const slotGeo = () => frame.evaluate(() => { const I = lively.identity.WikiIndex.current, e = lively.identity.WikiEditor.localEditors()[0], b = e.getBounds(); return { top: b.y, left: b.x, w: b.width, gridBottom: I._gridY + (I._gridContentHeight || 0), contentW: I._contentWidth(), contentLeft: I._contentLeft(), worldW: Math.round($world.visibleBounds().width), panelsShown: [I._sidebarBox.isVisible(), I._categoriesPanel.isVisible()] }; });
    await page.setViewportSize({ width: 1100, height: 800 });
    const small = await until(async () => { const g = await slotGeo(); return g.worldW <= 1100 && Math.abs(g.w - g.contentW) < 2 ? g : null; }, 10000);
    check('when the window is made smaller the open page keeps the place the index gives it: below the cards, as wide as the space left for it', !!small && small.top >= small.gridBottom && Math.abs(small.left - small.contentLeft) < 2, small || await slotGeo());
    await page.setViewportSize({ width: 1280, height: 900 });
    const big = await until(async () => { const g = await slotGeo(); return g.worldW >= 1270 && Math.abs(g.w - g.contentW) < 2 ? g : null; }, 10000);
    // (at 1100 the side panels are hidden and the page takes the width; at 1280 they are back and the page is narrower: the index decides, so the test asks only that the page is where the index says)
    check('at that width the two side panels are hidden while a page is open, so the page has the room', !!small && small.panelsShown[0] === false && small.panelsShown[1] === false, small);
    check('and when it is made bigger again it follows again, and the panels are back', !!big && big.top >= big.gridBottom && Math.abs(big.left - big.contentLeft) < 2 && !!small && big.w < small.w && big.panelsShown[0] === true && big.panelsShown[1] === true, { small, big });

    phase = '6 search';
    await click(page, await ctl(frame, (I) => I._searchField), 'the search field');
    await page.keyboard.type('work', { delay: 30 });
    ix = await until(async () => { const r = await readIndex(frame); return r && r.searchDropdown && r.searchDropdown.length ? r : null; }, 8000);
    check('typing in the search bar shows a dropdown of the pages whose name, category or tag matches', !!ix && ix.searchDropdown.includes('meeting-notes') && !ix.searchDropdown.includes('rome'), ix && ix.searchDropdown);
    await click(page, await rectOf(frame, () => { const I = lively.identity.WikiIndex.current, d = I._searchDropdown; return d && d.submorphs[0]; }), 'first result');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'meeting-notes' && r.open.hasView ? r : null; }, 30000);
    check('a click on a result opens that page', !!ix && ix.editors === 1 && ix.searchDropdown === null, ix);
    await click(page, await ctl(frame, (I) => I._searchField), 'the search field');
    await page.keyboard.press('Control+A'); await page.keyboard.type('zzzz', { delay: 30 });
    ix = await until(async () => { const r = await readIndex(frame); return r && r.searchDropdown && r.searchDropdown.some((t) => /No wiki pages match/.test(t)) ? r : null; }, 8000);
    check('words no page has say so', !!ix, ix && ix.searchDropdown);
    await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
    await until(async () => (await readIndex(frame)).searchDropdown === null, 6000);

    phase = '7 category and tag filters';
    await click(page, await panelRect(frame, 'Place (2)'), 'category Place');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.categoryFilter === 'Place' ? r : null; }, 6000);
    check('a click on a category shows only its pages', !!ix && JSON.stringify(ix.cards.map((c) => c.name).sort()) === '["paris-trip","rome"]', ix && ix.cards);
    await click(page, await panelRect(frame, 'France'), 'tag France');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.tagFilter === 'France' ? r : null; }, 6000);
    check('a click on a tag narrows it to the pages with that tag', !!ix && JSON.stringify(ix.cards.map((c) => c.name)) === '["paris-trip"]', ix && ix.cards);
    await click(page, await panelRect(frame, 'France'), 'tag France again');
    await click(page, await panelRect(frame, 'Place (2)'), 'category Place again');
    ix = await until(async () => { const r = await readIndex(frame); return r && !r.categoryFilter && !r.tagFilter ? r : null; }, 6000);
    check('clicking them again clears the filter', !!ix && ix.cards.length === 3, ix && ix.cards);

    phase = '8 a save that fails keeps the person on the page';
    ix = await readIndex(frame);
    await click(page, await cardRect(frame, 'rome'), 'card rome');
    await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'rome' && r.open.hasView && r.open.status === 'Saved' ? r : null; }, 30000);
    await frame.evaluate(() => { const e = lively.identity.WikiEditor.localEditors()[0]; e.yDoc.clientID = e.yDoc.clientID + 1; });
    const vBefore = (await shellList(page)).find((p) => p.name === 'rome').versions;
    await typeInPage(' forged');
    const refused = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.status === 'Not saved' ? r : null; }, 15000);
    check('(setup) an edit the shell refuses shows as "Not saved"', !!refused, await readIndex(frame));
    await click(page, await cardRect(frame, 'paris-trip'), 'card paris-trip');
    await sleep(2500);
    ix = await readIndex(frame);
    check('opening another page while the text cannot be saved does not move: the page stays, with the text, and one editor', !!ix && ix.open && ix.open.name === 'rome' && /forged/.test(ix.open.text || '') && ix.editors === 1, ix && ix.open);
    check('the person is told why the page was not left', (await told(frame)).some((m) => /was not left, because what you typed could not be saved/.test(m)), await told(frame));
    check('and nothing of the refused text is stored', (await shellList(page)).find((p) => p.name === 'rome').versions === vBefore);
    await frame.evaluate(() => { const e = lively.identity.WikiEditor.localEditors()[0]; e._userHasEdited = false; e._unsaved = []; e._unconfirmed = null; });
    await click(page, await cardRect(frame, 'paris-trip'), 'card paris-trip');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'paris-trip' && r.open.hasView ? r : null; }, 30000);
    check('once the unsaved text is given up the page can be left', !!ix && ix.editors === 1, ix);

    phase = '9 a reload comes back to the index, with the page open';
    await waitSaved('paris-trip', /Rome is not Paris/);
    pl = await place(page);
    check('(setup) the tab remembers the index with this page open', !!pl && pl.kind === 'wikiindex' && pl.id === did + '/paris-trip', pl);
    await page.reload();
    let landed = await landedOn(page);
    check('after a reload of the whole page the person lands on the wiki index', landed.kind === 'wikiindex', landed.kind);
    if (landed.kind !== 'wikiindex') throw new Error('the reload did not return to the wiki index: nothing after this can be trusted');
    frame = landed.frame; await installTell(frame);
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.hasView ? r : null; }, 30000);
    const sUp = await startup();
    check('with the same page open in it, with its text, and the new-page dialog not asked for again', !!ix && ix.open.name === 'paris-trip' && /Rome is not Paris/.test(ix.open.text || '') && ix.dialog === false && sUp.newPage === false, { open: ix && ix.open, sUp });
    check('and the three cards', !!ix && ix.cards.length === 3, ix && ix.cards);
    await click(page, await ctl(frame, (I) => I._sortByBox), 'sort button');
    await click(page, await rectOf(frame, () => { const I = lively.identity.WikiIndex.current; return I._sortByDropdown.submorphs.find((m) => typeof m.textString === 'string' && m.textString.trim() === 'All pages'); }), 'All pages');
    await until(async () => { const r = await readIndex(frame); return r && !r.open ? r : null; }, 10000);
    await sleep(500);
    await page.reload();
    landed = await landedOn(page);
    check('after closing the page, a reload comes back to the index with no page open', landed.kind === 'wikiindex' && (await (async () => { frame = landed.frame; const r = await until(async () => { const x = await readIndex(frame); return x && x.cards.length === 3 ? x : null; }, 30000); return !!r && !r.open; })()), landed.kind);

    phase = '10 leaving with typing not yet saved';
    frame = landed.frame || frame; await installTell(frame);
    await click(page, await cardRect(frame, 'meeting-notes'), 'card meeting-notes');
    await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'meeting-notes' && r.open.hasView && r.open.status === 'Saved' ? r : null; }, 30000);
    const v0 = (await shellList(page)).find((p) => p.name === 'meeting-notes').versions;
    await typeInPage(' and the red one');
    const pending = (await readIndex(frame)).open;
    check('(setup) the new typing has not been sent when the person leaves', !!pending && pending.unsaved > 0 && pending.status !== 'Saved', pending);
    await click(page, await ctl(frame, (I) => I._backBtn), 'the back pill');
    const home = await tryWorld(page, 'homestar', 25000);
    check('the back pill goes to the home page', !!home);
    if (!home) throw new Error('the back pill did not go to the home page: nothing after this can be trusted');
    frame = home;
    const left = await shellText(page, 'meeting-notes');
    check('and what was typed in the last moments was saved first (the pill waits for the editor)', /Agenda: budget and the red one/.test(left || '') && (await shellList(page)).find((p) => p.name === 'meeting-notes').versions > v0, left);
    pl = await place(page);
    check('moving to the home page forgets the place: a reload there is not the wiki', pl === null, pl);

    phase = '11 from a page\'s own world, up to the wiki';
    await openList();
    await until(async () => frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'WorldsBrowser'); return !!(w && w.get('worldsList') && w.get('worldsList').submorphs.some((m) => m.name === 'worldRow' && m.wikiId)); }), 20000);
    await click(page, await rectOf(frame, () => { const w = $world.submorphs.find((m) => m.name === 'WorldsBrowser'); const r = w.get('worldsList').submorphs.find((m) => m.name === 'worldRow' && m.worldName === 'rome'); return r && r.submorphs.find((x) => x.name === 'worldOpen'); }), 'open on the row of rome');
    frame = await waitForWorld(page, 'wiki');
    check('"open" on a page\'s row still goes to that page as a world of its own', (await startup()).id === did + '/rome');
    await click(page, await rectOf(frame, () => { const b = $world.get(/^MenuBar/); return b.submorphs.find((m) => m.name === 'WorldNameMenuBarEntry'); }), 'the world name in the menu bar');
    const upFrame = await tryWorld(page, 'wikiindex', 25000);
    check('clicking the page name in the menu bar moves to the wiki', !!upFrame);
    if (!upFrame) throw new Error('the page name in the menu bar did not lead to the wiki: nothing after this can be trusted');
    frame = upFrame;
    ix = await until(async () => { const r = await readIndex(frame); return r && r.cards.length === 3 ? r : null; }, 30000);
    check('a click on the page\'s name in the menu bar goes up to the wiki: it is the index, with no page open', !!ix && !ix.open && (await startup()).kind === 'wikiindex', ix && ix.open);

    phase = '11b the wiki name in the menu bar goes home';
    await click(page, await rectOf(frame, () => { const b = $world.get(/^MenuBar/); return b.submorphs.find((m) => m.name === 'WorldNameMenuBarEntry'); }), 'the wiki name in the menu bar');
    const homeAgain = await tryWorld(page, 'homestar', 25000);
    check('clicking the wiki name in the menu bar goes back to the home page', !!homeAgain);
    if (!homeAgain) throw new Error('the wiki name in the menu bar did not go home: nothing after this can be trusted');
    frame = homeAgain;
    await frame.evaluate(() => window.keo.call('world.go', { kind: 'wikiindex' }, 60000)).catch(() => {});
    frame = await waitForWorld(page, 'wikiindex');

    phase = '12 the shell\'s rules for the index';
    // asked of the shell page directly: where signing in or a reload would land, and who may say which page the index shows
    const sess = await page.evaluate(() => window.keoIdentity.current());
    const where = () => page.evaluate((x) => window.keoShell.landing(x).then((l) => ({ kind: l.kind, open: l.open === undefined ? null : l.open }), (e) => ({ kind: 'landing failed: ' + e.message })), sess);
    await page.evaluate((d) => window.keoIdentity.setPlace({ kind: 'wikiindex', id: d + '/rome' }), did);
    const w1 = await where();
    check('landing returns to a remembered index with its page', w1.kind === 'wikiindex' && w1.open === did + '/rome', w1);
    await page.evaluate((d) => window.keoIdentity.setPlace({ kind: 'wikiindex', id: d + '/not-held-' }), did);
    const w2 = await where();
    check('an own page that is not held yet (it is made when first saved) is still a place to come back to', w2.kind === 'wikiindex' && w2.open === did + '/not-held-', w2);
    const other = 'did:keo:' + 'a'.repeat(52) + ':' + 'B'.repeat(43);
    await page.evaluate((o) => window.keoIdentity.setPlace({ kind: 'wikiindex', id: o + '/theirs' }), other);
    const w3 = await where();
    check('a remembered page of someone else\'s that is not held does not lock the person out: the index alone', w3.kind === 'wikiindex' && w3.open === null, w3);
    await page.evaluate(() => window.keoIdentity.setPlace({ kind: 'wikiindex' }));
    check('the index with no page is a place too', (await place(page)) && (await place(page)).kind === 'wikiindex' && (await place(page)).id === null, await place(page));
    check('anything else is no place', await page.evaluate(() => window.keoIdentity.setPlace({ kind: 'world', id: 'x' }).then(() => window.keoIdentity.place() === null)));
    const badHere = await (async () => { await page.evaluate(() => window.keoIdentity.setPlace(null)); return frame.evaluate(() => window.keo.call('wiki.here', { id: 'x/y' }, 20000).then(() => 'accepted', (e) => e.message)); })();
    check('the index naming something that is not a page as the page it shows is refused, and no place is kept', /That is not the name of a page/.test(badHere) && (await place(page)) === null, { badHere, place: await place(page) });
    await page.evaluate(() => window.keoIdentity.setPlace(null));
    frame = await (async () => { await frame.evaluate(() => window.keo.call('world.go', { kind: 'homestar' }, 60000)).catch(() => {}); return waitForWorld(page, 'homestar'); })();
    const fromHome = await frame.evaluate(() => window.keo.call('wiki.here', {}, 20000).then(() => 'accepted', (e) => e.message));
    check('the home page may not say which page "the index" shows (only a world started as the index may)', /only be said from the wiki/.test(fromHome), fromHome);
    check('and that changed nothing: no place is remembered', (await place(page)) === null, await place(page));

    const unload = errors.filter((e) => /Blocked attempt to show a 'beforeunload' confirmation/.test(e));
    if (unload.length) note('the browser blocked ' + unload.length + ' "Leave site?" prompt(s), seen in: ' + unload.map((e) => (e.match(/\[([^\]]*)\]/) || [0, '?'])[1]).join('; '));
    // Step 8 refuses a save on purpose (the editor's client id is changed): the index logs that the page was not left, with the shell's reason,
    // and that is the only error allowed. It must be there: a list that only allows an error cannot show that the error was not missing.
    const refusal = errors.filter((e) => /\[8 a save that fails keeps the person on the page\] (\[WikiIndex\] )?(The page was not saved: |The page was not left, because what you typed could not be saved: )the edit writes with client id \d+, which is not one of this author's/.test(e));
    check('the refused move was logged with the reason the shell gave, in that step only', refusal.length >= 1, errors.slice(0, 6));
    const mine = errors.filter((e) => !unload.includes(e) && !refusal.includes(e));
    check('no other page errors or console errors during the run', mine.length === 0, mine.slice(0, 6));
  } catch (e) {
    console.log('FAIL test aborted in phase ' + phase + ': ' + (e && e.stack || e));
    console.log('errors seen: ' + JSON.stringify(errors.slice(-8)));
    failed++;
  } finally {
    await ctx.close();
  }
  console.log(failed ? 'FAILED: ' + failed : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
