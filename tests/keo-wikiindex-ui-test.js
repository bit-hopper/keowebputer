// The person's wiki on this device, used the way a person would: the INDEX of their pages (kernel lively.identity.WikiIndex, local scope), a
// world of its own that the shell starts (start kind 'wikiindex', world/keo-boot.js), as the host's own page for a wiki is. Reached from My
// worlds (Create, Wiki page: it goes to the index and asks for the new-page dialog, as the host's card hands off with "?new=1"; "open" on a
// page's row: it goes to the index with that page open, or opens the page in place when the world already is the index) and, from a
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
    // A page in the slot is its READING VIEW (reading: true, a WikiView of a page on this device) or its EDITOR (local: true). `ready` says the
    // page is drawn in either state (the editor has its document, the view has drawn the page); `hasView` is the editor's own.
    open: a ? { name: a._wikiName, local: !!a._local, reading: !!a._localPage, inIndex: !!a._inIndex || !!a._localPage, inWorld: a.owner === $world, hasView: !!a.editorView, ready: a._localPage ? !!a._localDrawn : !!a.editorView,
      canEdit: !!a._canEdit, canDelete: !!a._canDelete, status: a._statusEl ? a._statusEl.textContent : null,
      text: a._localPage ? (a._contentEl ? a._contentEl.textContent : null) : (a._pmContainer && a._pmContainer.querySelector('.ProseMirror') ? a._pmContainer.querySelector('.ProseMirror').textContent : null),
      unsaved: a._unsaved ? a._unsaved.length : null, session: a._pageSession || null } : null,
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
    // The reading view's "more" button and its menu, by real clicks: Edit swaps the view for the page's editor, as it does on a host. Waits until
    // the editor has its document and says Saved, so that what is typed next goes into the page.
    const menuItem = (label) => rectOf(frame, (l) => Array.from(document.querySelectorAll('div')).find((d) => d.children.length === 2 && d.firstElementChild.className.indexOf('material-symbols') >= 0 && d.lastElementChild.textContent === l), label);
    const clickEdit = async () => {
      await click(page, await ctl(frame, (I) => I._activeContentMorph._moreBtn), 'the more button of the page');
      await click(page, await until(() => menuItem('Edit'), 4000), 'Edit in the menu');
      return until(async () => { const r = await readIndex(frame); return r && r.open && r.open.local && r.open.hasView && r.open.status === 'Saved' ? r : null; }, 30000);
    };

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

    phase = '4b the window made narrower, with no page open';
    // The left list, the cards and the categories panel share the width, and the top row (back pill, search bar, sort menu, new-page button)
    // shares it too. When the window is too narrow they give way instead of being drawn over one another: the categories panel first, so that
    // the list of pages stays as long as it can, then the list when not even one column of cards fits beside it; the sort menu goes when the
    // search bar could not keep its least width beside it. What is on screen is read from the DOM, and any two parts that share area are an
    // overlap.
    const layoutOf = () => frame.evaluate(() => {
      const I = lively.identity.WikiIndex.current, dom = (m) => { const r = m.renderContext().shapeNode.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const vis = (m) => (m && m.isVisible() ? dom(m) : null);
      return { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, cards: (I._cardMorphs || []).map(dom),
        left: vis(I._sidebarBox), cats: vis(I._categoriesPanel), back: dom(I._backBtn), search: dom(I._searchBar), sort: vis(I._sortByBox), newBtn: vis(I._newBtn) || vis(I._newBtnCompact) };
    });
    const clashes = (L, withHeader) => {
      const parts = L.cards.map((c, i) => ['card ' + i, c]); if (L.left) parts.push(['left list', L.left]); if (L.cats) parts.push(['categories', L.cats]);
      if (withHeader) { parts.push(['back pill', L.back], ['search bar', L.search]); if (L.sort) parts.push(['sort menu', L.sort]); if (L.newBtn) parts.push(['new-page button', L.newBtn]); }
      const out = [];
      for (let i = 0; i < parts.length; i++) {
        const a = parts[i][1]; if (a.x < 0 || a.x + a.w > L.clientWidth) out.push(parts[i][0] + ' is outside the window');
        for (let j = i + 1; j < parts.length; j++) { const b = parts[j][1]; if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push(parts[i][0] + ' over ' + parts[j][0]); }
      }
      return out;
    };
    const resizeTo = async (w) => { await page.setViewportSize({ width: w, height: 900 }); await until(async () => (await layoutOf()).clientWidth === w, 8000); await sleep(700); return layoutOf(); };
    // [width, left list shown, categories shown, sort menu shown]. The widths stay clear of the exact limits (the back pill's width, which sets the
    // limit for the sort menu, depends on the font that was loaded), except the two panel limits, which do not depend on anything measured.
    for (const [w, wantLeft, wantCats, wantSort] of [[933, true, true, true], [908, true, true, true], [907, true, false, true], [700, true, false, true], [640, true, false, false], [624, true, false, false], [623, false, false, false], [500, false, false, false], [1280, true, true, true]]) {
      const L = await resizeTo(w), bad = clashes(L, true);
      check('at ' + w + ' px wide nothing is drawn over anything else, and nothing is outside the window', bad.length === 0 && L.cards.length === 3, { bad, cards: L.cards });
      check('at ' + w + ' px wide the list of pages is ' + (wantLeft ? 'shown' : 'hidden') + ', the categories panel ' + (wantCats ? 'shown' : 'hidden') + ' and the sort menu ' + (wantSort ? 'shown' : 'hidden'), !!L.left === wantLeft && !!L.cats === wantCats && !!L.sort === wantSort, { left: !!L.left, cats: !!L.cats, sort: !!L.sort });
      check('at ' + w + ' px wide the page does not scroll sideways', L.scrollWidth <= L.clientWidth, { scrollWidth: L.scrollWidth, clientWidth: L.clientWidth });
      // the room the sort menu leaves goes to the search bar: at 640 px it is wider than it can be with the menu beside it (240 px, its least)
      if (w === 640) check('at 640 px the search bar takes the room the sort menu left', L.search.w > 300, L.search);
    }
    // With a page open the sort menu stays, whatever the width: it holds "All pages", the only way back from a page to the cards.
    await resizeTo(640);
    await click(page, await cardRect(frame, 'rome'), 'card rome');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'rome' && r.open.ready ? r : null; }, 30000);
    const Lopen = await layoutOf();
    check('at 640 px with a page open the sort menu is shown again (it holds "All pages")', !!ix && !!Lopen.sort, { open: !!ix, sort: Lopen.sort });
    await click(page, await ctl(frame, (I) => I._sortByBox), 'sort button');
    const menuRows = await frame.evaluate(() => { const I = lively.identity.WikiIndex.current, d = I._sortByDropdown; return d ? d.submorphs.map((m) => typeof m.textString === 'string' ? m.textString.trim() : null).filter(Boolean) : null; });
    check('and its menu still has "All pages", so the way back to the cards is there', !!menuRows && menuRows.includes('All pages'), menuRows);
    await click(page, await rectOf(frame, () => { const I = lively.identity.WikiIndex.current; return I._sortByDropdown.submorphs.find((m) => typeof m.textString === 'string' && m.textString.trim() === 'All pages'); }), 'All pages');
    ix = await until(async () => { const r = await readIndex(frame); return r && !r.open ? r : null; }, 10000);
    const Lclosed = await layoutOf();
    check('"All pages" closes the page at that width, and with no page open the sort menu gives way again', !!ix && ix.editors === 0 && !Lclosed.sort && clashes(Lclosed, true).length === 0, { open: ix && ix.open, sort: Lclosed.sort, bad: clashes(Lclosed, true) });
    await resizeTo(1280);

    phase = '5 opening pages: a card, the left list, the home button';
    await click(page, await cardRect(frame, 'rome'), 'card rome');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'rome' && r.open.ready && /Colosseum/.test(r.open.text || '') ? r : null; }, 30000);
    check('a click on a card opens that page in the slot, as its READING VIEW, with its text', !!ix && ix.open.reading && !ix.open.local && ix.open.inIndex && ix.open.inWorld, ix);
    check('reading holds no editing session: there is no editor, and the view has no session with the shell', !!ix && ix.editors === 0 && ix.open.session === null, ix);
    await click(page, await ctl(frame, (I) => I._sidebarHomeBtn), 'home button of the left panel');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.leftHeader === 'ALL WIKI PAGES' ? r : null; }, 6000);
    check('the left panel\'s home button switches it to the list of every page, with a page still open', !!ix && ix.open && ix.open.name === 'rome' && ix.left.includes('paris-trip'), ix);
    // Edit (the menu of the view) swaps in the editor: that has a session, which the shell must be given back when the page is left
    const ed5 = await clickEdit();
    check('Edit in the page\'s menu swaps the view for the page\'s editor, in the same slot, on the same page, with its text', !!ed5 && ed5.open.name === 'rome' && ed5.open.inIndex && ed5.open.inWorld && /Colosseum/.test(ed5.open.text || '') && ed5.editors === 1 && !!ed5.open.session, ed5 && ed5.open);
    const sessionBefore = ed5 && ed5.open && ed5.open.session;
    // a page that takes the slot puts the left panel back on that page's outline (the host's swap does too): the home button again
    check('after the swap the left panel is the page\'s outline again', !!ed5 && ed5.leftHeader === 'ON THIS PAGE', ed5 && ed5.leftHeader);
    await click(page, await ctl(frame, (I) => I._sidebarHomeBtn), 'home button of the left panel, again');
    await until(async () => { const r = await readIndex(frame); return r && r.leftHeader === 'ALL WIKI PAGES' ? r : null; }, 6000);
    await click(page, await leftRect(frame, 'paris-trip'), 'paris-trip in the left list');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'paris-trip' && r.open.ready && /Rome is not Paris/.test(r.open.text || '') ? r : null; }, 30000);
    check('a page in the left list opens in the slot, in place of the one that was open, with its text, as a reading view', !!ix && ix.editors === 0 && ix.open.reading && ix.open.inIndex, ix);
    const closedSession = await page.evaluate(async (s) => { try { await window.keoWiki.pages().edit({ session: s, n: 99, update: new Uint8Array([1]) }); return 'accepted'; } catch (e) { return e.message; } }, sessionBefore);
    check('the shell session of the page that was left was given back', /not open for editing/.test(closedSession), closedSession);

    phase = '5b the window is made smaller and bigger';
    // The page in the slot is placed and sized by the index (below the cards, between the panels), not fitted to the whole world as a page
    // that is a world of its own is: when the window changes size it must still sit where the index puts it.
    const slotGeo = () => frame.evaluate(() => { const I = lively.identity.WikiIndex.current, e = I._activeContentMorph, b = e.getBounds(); return { top: b.y, left: b.x, w: b.width, gridBottom: I._gridY + (I._gridContentHeight || 0), contentW: I._contentWidth(), contentLeft: I._contentLeft(), worldW: Math.round($world.visibleBounds().width), panelsShown: [I._sidebarBox.isVisible(), I._categoriesPanel.isVisible()] }; });
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
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'meeting-notes' && r.open.ready ? r : null; }, 30000);
    check('a click on a result opens that page, as its reading view', !!ix && ix.editors === 0 && ix.open.reading && ix.searchDropdown === null, ix);
    await click(page, await ctl(frame, (I) => I._searchField), 'the search field');
    await page.keyboard.press('Control+A'); await page.keyboard.type('zzzz', { delay: 30 });
    ix = await until(async () => { const r = await readIndex(frame); return r && r.searchDropdown && r.searchDropdown.some((t) => /No wiki pages match/.test(t)) ? r : null; }, 8000);
    check('words no page has say so', !!ix, ix && ix.searchDropdown);
    await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
    await until(async () => (await readIndex(frame)).searchDropdown === null, 6000);

    phase = '6b search inside the pages';
    // The shell searches the TEXT of the pages too (names, categories and tags as before). Real typing in the search bar and real clicks on
    // the results; what is marked in the opened page is read from its DOM: the reading view's content, or the editor's document.
    const searchFor = async (q) => { await click(page, await ctl(frame, (I) => I._searchField), 'the search field'); await page.keyboard.press('Control+A'); await page.keyboard.type(q, { delay: 30 }); };
    // what the page in the slot holds about the marks, so that a failed check names the step that did not happen
    const markDiag = () => frame.evaluate(() => { const a = lively.identity.WikiIndex.current._activeContentMorph; if (!a) return null; if (a._localPage) return { reading: true, drawn: !!a._localDrawn, pending: a._highlightQuery, nodes: a._contentEl.querySelectorAll('.keo-search-mark').length }; const v = a.editorView, k = a._searchMarkKey, set = v && k && k.getState(v.state); return { pending: a._pendingSearch, hasKey: !!k, hasView: !!v, text: v ? v.state.doc.textContent.slice(0, 60) : null, decorations: set ? set.find().length : null, nodes: v ? v.dom.querySelectorAll('.keo-search-mark').length : null }; });
    const markedText = () => frame.evaluate(() => { const a = lively.identity.WikiIndex.current._activeContentMorph; if (!a) return null; const root = a._localPage ? a._contentEl : (a.editorView ? a.editorView.dom : null); return root ? Array.from(root.querySelectorAll('.keo-search-mark')).map((n) => n.textContent) : null; });
    const firstResult = () => rectOf(frame, () => { const I = lively.identity.WikiIndex.current, d = I._searchDropdown; return d && d.submorphs[0]; });
    await searchFor('colosseum');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.searchDropdown && r.searchDropdown.includes('rome') ? r : null; }, 10000);
    check('a word that is only in the text of a page finds that page, and only that page', !!ix && ix.searchDropdown.includes('rome') && !ix.searchDropdown.includes('meeting-notes') && !ix.searchDropdown.includes('paris-trip'), ix && ix.searchDropdown);
    check('the result shows the piece of the text around the word', !!ix && ix.searchDropdown.some((t) => /Colosseum/.test(t)), ix && ix.searchDropdown);
    const vRome = (await shellList(page)).find((p) => p.name === 'rome').versions;
    await click(page, await firstResult(), 'first result');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'rome' && r.open.ready && /Colosseum/.test(r.open.text || '') ? r : null; }, 30000);
    const mk = await until(async () => { const m = await markedText(); return m && m.length ? m : null; }, 10000);
    check('the page opened from the result is the reading view, with the word marked in its text', !!ix && ix.open.reading && !!mk && mk.length === 1 && mk[0] === 'Colosseum', mk || await markDiag());
    await sleep(2600);
    check('marking changed nothing: no version was made, and the text of the page is as it was', (await shellList(page)).find((p) => p.name === 'rome').versions === vRome && /The Colosseum$/.test((await readIndex(frame)).open.text || ''), { versions: (await shellList(page)).find((p) => p.name === 'rome').versions, text: (await readIndex(frame)).open.text });
    await searchFor('"is not paris"');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.searchDropdown && r.searchDropdown.includes('paris-trip') ? r : null; }, 10000);
    check('a quoted phrase finds the page that has it', !!ix && ix.searchDropdown.includes('paris-trip') && !ix.searchDropdown.includes('rome'), ix && ix.searchDropdown);
    await click(page, await firstResult(), 'first result');
    await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'paris-trip' && r.open.ready && /Rome is not Paris/.test(r.open.text || '') ? r : null; }, 30000);
    const mk2 = await until(async () => { const m = await markedText(); return m && m.length ? m : null; }, 10000);
    check('the whole phrase is marked, as it is written in the page', !!mk2 && mk2.length === 1 && mk2[0] === 'is not Paris', mk2 || await markDiag());
    // a result for a page that is open in its reading view marks the words in that view and does not open it again (the same view object)
    await frame.evaluate(() => { window.__viewRef = lively.identity.WikiIndex.current._activeContentMorph; });
    await searchFor('"is not"');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.searchDropdown && r.searchDropdown.includes('paris-trip') ? r : null; }, 10000);
    await click(page, await firstResult(), 'first result');
    const mkAgain = await until(async () => { const m = await markedText(); return m && m.length && m[0] === 'is not' ? m : null; }, 10000);
    check('a result for the page that is open as a view marks the new words in that same view (the old marks go), and does not open the page again', !!mkAgain && mkAgain.length === 1 && (await frame.evaluate(() => lively.identity.WikiIndex.current._activeContentMorph === window.__viewRef)) && (await readIndex(frame)).editors === 0, { mkAgain, diag: await markDiag() });
    // Edit: the editor opens with no marks, and writing in it saves as before
    await clickEdit();
    check('the editor that Edit opens carries no marks', (await markedText() || []).length === 0, await markedText());
    await typeInPage(' zzz');
    const gone = await until(async () => { const m = await markedText(); return m && m.length === 0 ? true : null; }, 6000);
    check('writing in the page leaves it with no marks', gone === true, await markedText());
    await waitSaved('paris-trip', /Rome is not Paris zzz/);
    // a result for the page that is open already marks the words in it, and does not open it again
    const sessionOpen = (await readIndex(frame)).open.session;
    await searchFor('zzz');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.searchDropdown && r.searchDropdown.includes('paris-trip') ? r : null; }, 10000);
    check('(setup) searching for what was just typed finds the page that is open', !!ix && ix.searchDropdown.includes('paris-trip'), ix && ix.searchDropdown);
    await click(page, await firstResult(), 'first result');
    const mk3 = await until(async () => { const m = await markedText(); return m && m.length ? m : null; }, 10000);
    ix = await readIndex(frame);
    check('a result for the page that is already open marks the words in it, and does not open it again (one editor, the same session)', !!mk3 && mk3.join() === 'zzz' && ix.editors === 1 && ix.open.session === sessionOpen, { mk3, editors: ix.editors, same: ix.open.session === sessionOpen });
    // an answer that is late, and one for a query that was cleared, are not shown
    const late = await frame.evaluate(() => new Promise((resolve) => {
      const li = lively.identity.localIdentity, real = li.wikiSearch, I = lively.identity.WikiIndex.current;
      li.wikiSearch = function (q, cb) { if (q === 'colosseum') setTimeout(function () { real.call(li, q, cb); }, 700); else real.call(li, q, cb); };
      const shown = () => { const out = []; if (I._searchDropdown) (function walk(m) { if (typeof m.textString === 'string' && m.textString) out.push(m.textString); (m.submorphs || []).forEach(walk); })(I._searchDropdown); return out; };
      I._searchLocal('colosseum'); I._searchLocal('work');
      setTimeout(function () {
        const afterTwo = shown();
        I._searchLocal('colosseum'); I._queueContentSearch('');
        setTimeout(function () { li.wikiSearch = real; resolve({ afterTwo: afterTwo, afterCleared: I._searchDropdown ? shown() : null }); }, 1500);
      }, 1500);
    }));
    check('an answer that arrives after a later query is dropped: the dropdown is the later query\'s', late.afterTwo.includes('meeting-notes') && !late.afterTwo.includes('rome'), late.afterTwo);
    check('and an answer on its way to a query that was cleared does not bring the dropdown back', late.afterCleared === null, late.afterCleared);
    // the shell cannot search: the person is told, and the pages are matched by name, category and tag from the list the index holds
    await frame.evaluate(() => { window.__realSearch = lively.identity.localIdentity.wikiSearch; lively.identity.localIdentity.wikiSearch = function (q, cb) { cb(new Error('the shell said no')); }; });
    await searchFor('work');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.searchDropdown && r.searchDropdown.includes('meeting-notes') ? r : null; }, 10000);
    check('when the shell cannot search, the pages are still matched by name, category and tag', !!ix && ix.searchDropdown.includes('meeting-notes') && !ix.searchDropdown.includes('rome'), ix && ix.searchDropdown);
    check('and the person is told that searching inside the pages did not work, and why', (await told(frame)).some((m) => /Searching inside your pages did not work: the shell said no/.test(m)), await told(frame));
    await frame.evaluate(() => { lively.identity.localIdentity.wikiSearch = window.__realSearch; });
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
    await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'rome' && r.open.ready ? r : null; }, 30000);
    await clickEdit();
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
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'paris-trip' && r.open.ready ? r : null; }, 30000);
    check('once the unsaved text is given up the page can be left (the other page opens, as a reading view, and no editor is left)', !!ix && ix.editors === 0 && ix.open.reading, ix);

    phase = '9 a reload comes back to the index, with the page open';
    await waitSaved('paris-trip', /Rome is not Paris/);
    pl = await place(page);
    check('(setup) the tab remembers the index with this page open', !!pl && pl.kind === 'wikiindex' && pl.id === did + '/paris-trip', pl);
    await page.reload();
    let landed = await landedOn(page);
    check('after a reload of the whole page the person lands on the wiki index', landed.kind === 'wikiindex', landed.kind);
    if (landed.kind !== 'wikiindex') throw new Error('the reload did not return to the wiki index: nothing after this can be trusted');
    frame = landed.frame; await installTell(frame);
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.ready ? r : null; }, 30000);
    const sUp = await startup();
    check('with the same page open in it, as its reading view (not the editor), with its text, and the new-page dialog not asked for again', !!ix && ix.open.name === 'paris-trip' && ix.open.reading && /Rome is not Paris/.test(ix.open.text || '') && ix.dialog === false && sUp.newPage === false, { open: ix && ix.open, sUp });
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
    await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'meeting-notes' && r.open.ready ? r : null; }, 30000);
    await clickEdit();
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

    phase = '11 "open" on a page\'s row in My worlds, from the home page';
    // "open" on a page of the person's own goes to where their pages are read: the wiki's index, with that page open in it (the list of pages
    // on the left, the categories on the right), not to the page alone.
    const rowsListed = () => until(async () => frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'WorldsBrowser'); return !!(w && w.get('worldsList') && w.get('worldsList').submorphs.some((m) => m.name === 'worldRow' && m.wikiId)); }), 20000);
    const rowOpen = (name) => rectOf(frame, (n) => { const w = $world.submorphs.find((m) => m.name === 'WorldsBrowser'); const r = w.get('worldsList').submorphs.find((m) => m.name === 'worldRow' && m.worldName === n); return r && r.submorphs.find((x) => x.name === 'worldOpen'); }, name);
    const winCount = () => frame.evaluate(() => $world.submorphs.filter((m) => m.name === 'WorldsBrowser').length);
    await openList();
    await rowsListed();
    await click(page, await rowOpen('rome'), 'open on the row of rome');
    const toIndex = await tryWorld(page, 'wikiindex', 30000);
    check('"open" on a page\'s row moves to a world that starts as the wiki index', !!toIndex);
    if (!toIndex) throw new Error('"open" on the page\'s row did not go to the wiki index: nothing after this can be trusted');
    frame = toIndex;
    await installTell(frame);
    const sRow = await startup();
    check('"open" on a page\'s row moves to the wiki index, with that page named as the one to show', sRow.kind === 'wikiindex' && sRow.open === did + '/rome' && sRow.newPage === false, sRow);
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.ready ? r : null; }, 30000);
    check('the page is open in the index\'s slot, as its reading view, with the three cards and the list of the wiki around it', !!ix && ix.open.name === 'rome' && ix.open.reading && ix.open.inIndex && ix.open.inWorld && ix.editors === 0 && ix.cards.length === 3 && ix.leftHeader === 'ON THIS PAGE', ix);
    const sides = await frame.evaluate(() => { const I = lively.identity.WikiIndex.current, v = $world.visibleBounds(), c = (m) => { const b = m.getBounds(); return b.x + b.width / 2; }; return { list: c(I._sidebarBox), cats: c(I._categoriesPanel), mid: v.x + v.width / 2 }; });
    check('the list of pages is on the left and the categories panel on the right, as on the host', sides.list < sides.mid && sides.cats > sides.mid, sides);
    pl = await place(page);
    check('the tab remembers the index with that page open', !!pl && pl.kind === 'wikiindex' && pl.id === did + '/rome', pl);

    phase = '11b "open" on a page\'s row, inside the index';
    // The world already is the index: the page opens in the slot, no new world, and the window that was asked has done its work.
    await frame.evaluate(() => { window.__sameWorld = 'yes'; });
    await clickEdit();
    await typeInPage(' ++typed before the next page');
    const pend11 = (await readIndex(frame)).open;
    check('(setup) the last typing has not been sent when the person opens another page', !!pend11 && pend11.unsaved > 0, pend11);
    await openList();
    await rowsListed();
    await click(page, await rowOpen('paris-trip'), 'open on the row of paris-trip');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'paris-trip' && r.open.ready ? r : null; }, 30000);
    check('opening another page from My worlds, inside the index, opens it in the slot, as its reading view (the editor of the old page is gone)', !!ix && ix.editors === 0 && ix.open.reading && ix.cards.length === 3, ix && ix.open);
    check('and it is the same world: no new world was started for it', (await frame.evaluate(() => window.__sameWorld)) === 'yes' && (await startup()).kind === 'wikiindex');
    check('the My worlds window is gone, as it is when a move replaces the world', (await winCount()) === 0);
    check('what was typed in the page that was left was saved first', /\+\+typed before the next page/.test((await shellText(page, 'rome')) || ''), await shellText(page, 'rome'));
    pl = await until(async () => { const p = await place(page); return p && p.id === did + '/paris-trip' ? p : null; }, 10000);
    check('the tab remembers the page that is open now', !!pl, await place(page));
    await openList();
    await rowsListed();
    await click(page, await rowOpen('paris-trip'), 'open on the row of the page that is open');
    await until(async () => (await winCount()) === 0, 8000);
    ix = await readIndex(frame);
    check('"open" on the page that is already open leaves it as it is (the same reading view, the same world) and closes the window', !!ix && ix.open && ix.open.name === 'paris-trip' && ix.open.reading && ix.editors === 0 && (await winCount()) === 0 && (await frame.evaluate(() => window.__sameWorld)) === 'yes', ix && ix.open);

    phase = '11c "open" on a page\'s row while the text cannot be saved';
    await clickEdit();
    await frame.evaluate(() => { const e = lively.identity.WikiEditor.localEditors()[0]; e.yDoc.clientID = e.yDoc.clientID + 1; });
    const v11 = (await shellList(page)).find((p) => p.name === 'paris-trip').versions;
    await typeInPage(' forged again');
    const refused11 = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.status === 'Not saved' ? r : null; }, 15000);
    check('(setup) an edit the shell refuses shows as "Not saved"', !!refused11, await readIndex(frame));
    await openList();
    await rowsListed();
    await click(page, await rowOpen('rome'), 'open on the row of rome');
    await sleep(2500);
    ix = await readIndex(frame);
    check('the page stays, with its text, and the window stays open', !!ix && ix.open && ix.open.name === 'paris-trip' && /forged again/.test(ix.open.text || '') && ix.editors === 1 && (await winCount()) === 1, ix && ix.open);
    const line11 = await frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'WorldsBrowser'), t = w && w.get('worldsStatus'); return t ? String(t.textString) : null; });
    check('the line under the list says the page was not left and why (the shell\'s reason is in it)', /^The page was not left, because what you typed could not be saved: .*which is not one of this author's/.test(line11 || ''), line11);
    check('and nothing of the refused text is stored', (await shellList(page)).find((p) => p.name === 'paris-trip').versions === v11);
    await frame.evaluate(() => { const e = lively.identity.WikiEditor.localEditors()[0]; e._userHasEdited = false; e._unsaved = []; e._unconfirmed = null; });
    await click(page, await rowOpen('rome'), 'open on the row of rome, again');
    ix = await until(async () => { const r = await readIndex(frame); return r && r.open && r.open.name === 'rome' && r.open.ready ? r : null; }, 30000);
    check('once the unsaved text is given up it opens (as a reading view), and the window closes', !!ix && ix.editors === 0 && ix.open.reading && (await winCount()) === 0, ix && ix.open);

    phase = '11d a page of someone else\'s, and the page as a world of its own';
    // The index lists the person's own pages only, so a page of someone else's that this device holds cannot be opened inside it: "open" goes
    // to it as a world of its own. No such page can be held here (nothing syncs yet), so this checks WHICH move "open" asks for, with the two
    // moves stubbed in the world for the length of the call; that the move itself works is checked below for a page of the person's own.
    await openList();
    await rowsListed();
    const asked = await frame.evaluate(() => {
      const li = lively.identity.localIdentity, calls = [], g = li.wikiGo, i = li.wikiIndexGo, w = $world.submorphs.find((m) => m.name === 'WorldsBrowser');
      li.wikiGo = function (r) { calls.push(['wikiGo', r.id]); }; li.wikiIndexGo = function (o) { calls.push(['wikiIndexGo', o.id]); };
      try { w.localOpenWiki({ wiki: true, id: 'did:keo:x/theirs', name: 'theirs', mine: false }); } finally { li.wikiGo = g; li.wikiIndexGo = i; }
      return calls;
    });
    check('"open" on a page that is not the person\'s own asks for that page as a world of its own, not for the index', JSON.stringify(asked) === JSON.stringify([['wikiGo', 'did:keo:x/theirs']]), asked);
    await frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'WorldsBrowser'); if (w) w.initiateShutdown(); });
    await frame.evaluate((d) => { lively.identity.localIdentity.wikiGo({ id: d + '/rome' }); }, did);
    frame = await waitForWorld(page, 'wiki');
    check('a page can still be gone to as a world of its own (a direct link does)', (await startup()).id === did + '/rome');
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
    // Steps 8 and 11c refuse a save on purpose (the editor's client id is changed): the index logs that the page was not left, with the shell's
    // reason, and that is the only error allowed, in those two steps. Each must be there: a list that only allows an error cannot show that
    // the error was not missing.
    const refusalIn = (step) => errors.filter((e) => e.indexOf('[' + step + '] ') !== -1 && /(\[WikiIndex\] )?(The page was not saved: |The page was not left, because what you typed could not be saved: )the edit writes with client id \d+, which is not one of this author's/.test(e));
    const refusal = refusalIn('8 a save that fails keeps the person on the page').concat(refusalIn('11c "open" on a page\'s row while the text cannot be saved'));
    check('the refused moves were logged with the reason the shell gave, in those two steps only (each has one)', refusalIn('8 a save that fails keeps the person on the page').length >= 1 && refusalIn('11c "open" on a page\'s row while the text cannot be saved').length >= 1, errors.slice(0, 6));
    // Step 6b makes the shell's search fail on purpose: the index says so on screen and in the console, in that step only.
    const searchFail = errors.filter((e) => e.indexOf('[6b search inside the pages] ') !== -1 && /Searching inside your pages did not work: the shell said no/.test(e));
    check('the failed search was logged with the reason, in that step only', searchFail.length >= 1, errors.slice(0, 6));
    const mine = errors.filter((e) => !unload.includes(e) && !refusal.includes(e) && !searchFail.includes(e));
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
