// The library on this device: the shell's sealed store for the small objects the runtime's apps keep (shell/keo-library.js), and the
// Books app used like a person would on a device with no host: add a book by typing it, shelve and rate it, make a list, close and
// reopen the world, delete a book. What is checked on the store: what comes back is what went in, what is refused, what is on disk
// (nothing readable), that a changed or moved record is not handed back, that removing an identity removes its library.
// Usage: node keo-library-test.js <repo root> <extension folder> <work dir>
// A headed browser with the extension loaded, `localhost` unresolvable, a virtual authenticator with PRF (so nothing here says anything
// about a real one). There is no host here: every request that would have gone to one is recorded and must be none.
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
const lib = (page, fn, args) => page.evaluate(([f, a]) => window.keoLibrary[f](a).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [fn, args || {}]);
async function until(fn, ms) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > (ms || 15000)) return v; await sleep(250); } }

// A real click on an element of the world (a DOM element inside the world's frame): on the part of it that is on screen, because the
// menu bar floats over the top edge of the app's header.
async function clickEl(page, loc) {
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  if (!b) throw new Error('no box for ' + loc);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height - Math.min(5, b.height / 2));
}
// the state of the running Books app
const booksState = (frame) => frame.evaluate(() => {
  const m = $world.submorphs.find((x) => x.name === 'Books');
  if (!m || !m.state) return null;
  return { loaded: m.state.loaded, owner: m.state.isOwner, lib: m.booksLibraryObjId || null, handle: m.booksLibraryHandle || null,
    books: m.state.books.map((b) => ({ objId: b.objId, title: b.title, author: b.author, shelf: b.shelf, rating: b.rating, isPublic: b.isPublic })),
    lists: m.state.lists.map((l) => ({ objId: l.objId, name: l.name, visibility: l.visibility, entries: l.bookEntries.length })) };
});
const musicState = (frame) => frame.evaluate(() => {
  const m = $world.submorphs.find((x) => x.name === 'Music');
  if (!m || !m.state) return null;
  return { loaded: m.state.loaded, owner: m.state.isOwner, lib: m.musicLibraryObjId || null, handle: m.musicLibraryHandle || null,
    sub: m._dom && m._dom.subEl ? m._dom.subEl.textContent : '', libBtn: m._dom && m._dom.libBtn ? getComputedStyle(m._dom.libBtn).display : '',
    albums: m.state.albums.map((a) => ({ objId: a.objId, title: a.title, artist: a.artist, year: a.year, shelf: a.shelf, rating: a.rating, tracks: (a.tracks || []).length, src: a.coverSource, isPublic: a.isPublic, itunes: a.ids && a.ids.itunes })),
    playlists: m.state.playlists.map((p) => ({ objId: p.objId, name: p.name, visibility: p.visibility, entries: p.entries.map((e) => e.title) })) };
});
// the raw records of the library database, as they are on disk
const rawDocs = (page) => page.evaluate(() => new Promise((res, rej) => {
  const q = indexedDB.open('keo-library');
  q.onerror = () => rej(q.error);
  q.onsuccess = () => { const db = q.result; const r = db.transaction('docs').objectStore('docs').getAll(); r.onsuccess = () => { db.close(); res(r.result.map((x) => ({ id: x.id, did: x.did, iv: x.iv, ct: Array.from(x.ct) }))); }; };
}));

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-library'), {
    headless: false, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  try {
    const page = await ctx.newPage();
    const errors = [], requests = [];
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error' && /keo-library|shell\.js/.test(m.location().url || '')) errors.push('console: ' + m.text().slice(0, 200)); });
    // anything aimed at a host or at a search service
    const hostish = /\/@did:|\/nodejs\/|\/dids\/|\/blobs\//;
    const outside = [];           // requests to the public catalogues (answered by the mock below, never by the real ones)
    const fonts = new Set();
    page.on('request', (r) => { if (/^https:\/\/(openlibrary\.org|itunes\.apple\.com)\//.test(r.url())) outside.push(r.url()); });
    page.on('request', (r) => { if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) fonts.add(new URL(r.url()).host); else if (hostish.test(r.url())) requests.push(r.url()); });
    // The public catalogues are answered here, so the test needs no network and says exactly what was asked of them.
    const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    await ctx.route(/^https:\/\/(openlibrary\.org|itunes\.apple\.com)\//, (route) => {
      const u = new URL(route.request().url());
      let body = {};
      if (u.hostname === 'openlibrary.org') body = { docs: [{ title: 'Dune', author_name: ['Frank Herbert'], isbn: ['9780441013593'], cover_i: 0 }] };
      else if (u.pathname === '/search' && u.searchParams.get('entity') === 'album') body = { results: [{ wrapperType: 'collection', collectionId: 111, collectionName: 'Kind of Blue', artistName: 'Miles Davis', releaseDate: '1959-08-17T07:00:00Z', artworkUrl100: 'https://art.invalid/100x100bb.jpg', trackCount: 2, collectionViewUrl: 'https://music.invalid/album/111' }] };
      else if (u.pathname === '/search') body = { results: [{ wrapperType: 'track', trackId: 222, trackName: 'So What', artistName: 'Miles Davis', collectionName: 'Kind of Blue', previewUrl: 'https://art.invalid/p.m4a', trackTimeMillis: 540000 }] };
      else if (u.pathname === '/lookup') body = { results: [{ wrapperType: 'collection', collectionId: 111 }, { wrapperType: 'track', trackId: 222, trackName: 'So What', trackNumber: 1, discNumber: 1, trackTimeMillis: 540000, previewUrl: 'https://art.invalid/p.m4a' }, { wrapperType: 'track', trackId: 223, trackName: 'Freddie Freeloader', trackNumber: 2, discNumber: 1, trackTimeMillis: 590000, previewUrl: 'https://art.invalid/q.m4a' }] };
      route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(body) });
    });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });

    await page.goto(`chrome-extension://${ID}/start.html`);
    let frame = await waitForWorld(page, 'gate');
    const made = await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }));
    const DID = made.did;
    await keoCall(frame, 'world.go', { kind: 'enter' }).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    check('setup: the shell offers the library, and the world has the two bridge ops', await page.evaluate(() => typeof window.keoLibrary.get === 'function' && typeof window.keoLibrary.put === 'function' && typeof window.keoLibrary.purge === 'function'));

    // ---- 1. the store
    const idA = 'AAAAAAAAAAAA', idB = 'BBBBBBBBBBBB';
    const folder = { objId: idA, did: DID, type: 'folder', created: '2026-01-01T00:00:00.000Z', record: { cid: 'c1', prevCid: null, payload: { name: 'Library', files: [], albums: [] } }, state: { name: 'Library' } };
    const book = { objId: idB, did: DID, type: 'book', created: '2026-01-01T00:00:00.000Z', record: { cid: 'c2', prevCid: null, payload: { title: 'The Pineapple Cipher', author: 'Ada Q' } }, state: { title: 'The Pineapple Cipher' } };
    check('store: a document that was never put is null, not an error', (await lib(page, 'get', { objId: idA })).r === null);
    check('store: put says true', (await lib(page, 'put', { objId: idA, doc: folder })).r === true && (await lib(page, 'put', { objId: idB, doc: book })).r === true);
    const back = await lib(page, 'get', { objId: idB });
    check('store: what comes back is what went in', back.ok && JSON.stringify(back.r) === JSON.stringify(book), back);
    book.record.payload.title = 'The Pineapple Cipher, revised';
    await lib(page, 'put', { objId: idB, doc: book });
    check('store: a second put replaces the document', (await lib(page, 'get', { objId: idB })).r.record.payload.title === 'The Pineapple Cipher, revised' && (await rawDocs(page)).length === 2);

    let r = await lib(page, 'put', { objId: 'short', doc: folder });
    check('store: an id that is not 12 characters of the id alphabet is refused', !r.ok && /valid library id/.test(r.e), r);
    r = await lib(page, 'get', { objId: '../../etc/pass' });
    check('store: so is one that looks like a path', !r.ok && /valid library id/.test(r.e), r);
    r = await lib(page, 'put', { objId: idA, doc: Object.assign({}, folder, { objId: idB }) });
    check('store: a document stored under another id than its own is refused', !r.ok && /carry the id/.test(r.e), r);
    r = await lib(page, 'put', { objId: idA, doc: Object.assign({}, folder, { did: 'did:keo:someone-else' }) });
    check('store: a document of another identity is refused', !r.ok && /signed-in identity/.test(r.e), r);
    r = await lib(page, 'put', { objId: idA, doc: Object.assign({}, folder, { type: 'file' }) });
    check('store: a kind that is not one of the app kinds is refused', !r.ok && /Not a kind/.test(r.e), r);
    r = await lib(page, 'put', { objId: idA, doc: Object.assign({}, folder, { filler: 'x'.repeat(2.1 * 1024 * 1024) }) });
    check('store: a document over the size limit is refused', !r.ok && /at most 2 MB/.test(r.e), r.e);
    r = await lib(page, 'put', { objId: idA, doc: [1, 2] });
    check('store: something that is not an object is refused', !r.ok, r);
    check('store: the refused puts changed nothing', (await lib(page, 'get', { objId: idA })).r.state.name === 'Library' && (await rawDocs(page)).length === 2);

    // what is on disk
    const raw = await rawDocs(page);
    const rawText = JSON.stringify(raw);
    check('disk: no title, author or name can be read from the stored records', !/Pineapple|Ada Q|Library/.test(rawText) && !/Pineapple|Library/.test(String.fromCharCode.apply(null, raw[0].ct.concat(raw[1].ct))), rawText.slice(0, 200));
    check('disk: a record has only the id (identity and object), the identity, an iv and sealed bytes', raw.every((x) => Object.keys(x).sort().join() === 'ct,did,id,iv' && x.id === DID + '|' + (x.id.split('|')[1])), raw.map((x) => Object.keys(x)));
    // a changed record is not handed back
    await page.evaluate(([id]) => new Promise((res) => { const q = indexedDB.open('keo-library'); q.onsuccess = () => { const db = q.result, t = db.transaction('docs', 'readwrite'), s = t.objectStore('docs'); const g = s.get(id); g.onsuccess = () => { const v = g.result; v.ct[3] ^= 1; s.put(v); }; t.oncomplete = () => { db.close(); res(); }; }; }), [DID + '|' + idA]);
    r = await lib(page, 'get', { objId: idA });
    check('disk: a record with one changed byte is refused, not returned as something else', !r.ok && /could not be decrypted/.test(r.e), r);
    // a record moved to another slot of the same identity is not handed back (the slot is part of what is sealed)
    await page.evaluate(([from, to, did]) => new Promise((res) => { const q = indexedDB.open('keo-library'); q.onsuccess = () => { const db = q.result, t = db.transaction('docs', 'readwrite'), s = t.objectStore('docs'); const g = s.get(from); g.onsuccess = () => { const v = g.result; s.put({ id: to, did: did, iv: v.iv, ct: v.ct }); }; t.oncomplete = () => { db.close(); res(); }; }; }), [DID + '|' + idB, DID + '|CCCCCCCCCCCC', DID]);
    r = await lib(page, 'get', { objId: 'CCCCCCCCCCCC' });
    check('disk: a record copied into another slot is refused', !r.ok && /could not be decrypted/.test(r.e), r);
    // the world asks through the bridge, as the apps do
    const viaBridge = await keoCall(frame, 'library.get', { objId: idB });
    check('bridge: the world gets a document through library.get', viaBridge.ok && viaBridge.r.state.title === 'The Pineapple Cipher', viaBridge);
    const noKey = await keoCall(frame, 'library.put', { objId: idB, doc: Object.assign({}, book, { did: 'did:keo:x' }) });
    check('bridge: and the same refusals apply to it', !noKey.ok && /signed-in identity/.test(noKey.e), noKey);
    // clear this test data before the app makes its own
    await page.evaluate((d) => window.keoLibrary.purge(d), DID);
    check('purge: removing the identity\'s library leaves nothing, found by the identity and needing no key', (await rawDocs(page)).length === 0 && (await lib(page, 'get', { objId: idB })).r === null);

    // ---- 2. Books, used by a person
    await keoCall(frame, 'world.go', { kind: 'blank', name: 'Reading', template: 'books' }).catch(() => {});
    frame = await waitForWorld(page, 'blank', 'Reading');
    let st = await until(async () => { const s = await booksState(frame); return s && s.loaded ? s : null; }, 30000);
    check('books: the app opens in a world made from the preset, and its library is made (no host involved)', !!st && st.owner === true && !!st.lib && st.handle === DID, st);
    const lib1 = st && st.lib;
    const saved = await until(async () => { const d = (await keoCall(frame, 'world.load', { name: 'Reading' })).r; return d && d.doc && d.doc.indexOf(lib1) >= 0 ? d : null; }, 20000);
    check('books: the saved world remembers which library it uses (so a reopened world does not make another)', !!saved);
    check('books: the library folder is in the sealed store, as a folder of this identity', await (async () => { const g = await lib(page, 'get', { objId: lib1 }); return g.ok && g.r && g.r.type === 'folder' && g.r.did === DID && g.r.visibility === 'public' && g.r.record.payload.name === 'Library'; })());
    await page.screenshot({ path: path.join(WORK, 'books-empty.png') });

    // add a book by typing it
    await clickEl(page, frame.locator('.hdr-addbtn'));
    check('books: "+ Add a Book" opens the Add box, which asks for a title and an author (no search)', await until(async () => (await frame.locator('.add-box input').count()) === 2 && /by hand/.test(await frame.locator('.add-hint').innerText()), 6000));
    await frame.locator('.add-box input').nth(0).click();
    await page.keyboard.type('The Left Hand of Darkness', { delay: 20 });
    await frame.locator('.add-box input').nth(1).click();
    await page.keyboard.type('Ursula K. Le Guin', { delay: 20 });
    check('books: what was typed is offered as the book to add', (await frame.locator('.add-result-title').innerText()) === 'The Left Hand of Darkness' && (await frame.locator('.add-result-author').innerText()) === 'Ursula K. Le Guin');
    await page.keyboard.press('Enter');
    st = await until(async () => { const s = await booksState(frame); return s && s.books.length === 1 ? s : null; }, 10000);
    check('books: Enter adds it: one book on the shelf, "want to read", not public', !!st && st.books[0].title === 'The Left Hand of Darkness' && st.books[0].author === 'Ursula K. Le Guin' && st.books[0].shelf === 'want' && st.books[0].isPublic === false, st);
    check('books: the tile is on the page', (await frame.locator('.book-tile').count()) === 1 && /Left Hand/.test(await frame.locator('.book-tile').first().innerText()));
    const bookId = st && st.books[0].objId;
    const stored = bookId ? await lib(page, 'get', { objId: bookId }) : null;
    check('books: the book is in the sealed store, unsigned, as a book of this identity', !!stored && stored.ok && stored.r.type === 'book' && stored.r.did === DID && stored.r.record.payload.title === 'The Left Hand of Darkness' && !stored.r.sig, stored);
    const folderNow = await lib(page, 'get', { objId: lib1 });
    check('books: and the library folder points at it', folderNow.ok && folderNow.r.record.payload.files.some((f) => f.refObjId === bookId && f.refType === 'book'), folderNow.r && folderNow.r.record.payload);

    // a second book through the Add box, then shelve and rate the first through the detail page
    await clickEl(page, frame.locator('.hdr-addbtn'));
    await frame.locator('.add-box input').nth(0).click();
    await page.keyboard.type('Piranesi', { delay: 20 });
    await frame.locator('.add-result .btn-primary').click();
    st = await until(async () => { const s = await booksState(frame); return s && s.books.length === 2 ? s : null; }, 10000);
    check('books: the Add button of the offered row works too; an author left empty is "Unknown"', !!st && st.books.some((b) => b.title === 'Piranesi' && b.author === 'Unknown'), st);
    await page.keyboard.press('Escape');
    if (await frame.locator('.add-box').isVisible()) await clickEl(page, frame.locator('.add-hdr .btn-ghost'));
    await clickEl(page, frame.locator('.book-tile', { hasText: 'Left Hand' }));
    await until(async () => (await frame.locator('.detail-title').innerText().catch(() => '')) === 'The Left Hand of Darkness', 6000);
    check('books: a tile opens the book', (await frame.locator('.detail-title').innerText()) === 'The Left Hand of Darkness');
    check('books: there is no Reviews & Notes section (it lives on a host) and no privacy pill', !(await frame.getByText('Reviews & Notes').isVisible()) && !(await frame.locator('.detail-body .privacy-pill').first().isVisible()));
    await clickEl(page, frame.locator('.shelf-pill-row .btn', { hasText: 'Reading' }));
    await clickEl(page, frame.locator('.star-btn').nth(3));
    st = await until(async () => { const s = await booksState(frame); const b = s && s.books.find((x) => /Left Hand/.test(x.title)); return b && b.shelf === 'reading' && b.rating === 4 ? s : null; }, 8000);
    check('books: shelving it as "Reading" and rating it four stars are kept', !!st, st);
    const stored2 = await lib(page, 'get', { objId: bookId });
    check('books: and are in the store; each change names the version before it (two changes since it was added)', stored2.r.record.payload.shelf === 'reading' && stored2.r.record.payload.rating === 4 && !!stored2.r.record.prevCid && stored2.r.record.prevCid !== stored.r.record.cid && stored2.r.record.cid !== stored.r.record.cid, stored2.r && stored2.r.record);

    // a list: no visibility to choose, no "Public" badge
    await clickEl(page, frame.locator('.detail-title').locator('xpath=ancestor::div[contains(@class,"detail-top")]').locator('.btn-ghost'));
    await clickEl(page, frame.locator('.side-newbtn'));
    await until(async () => (await frame.locator('.newlist-form').count()) === 1, 5000);
    check('lists: the new list form asks for a name only: no Private/Shared/Public buttons', (await frame.locator('.newlist-form .newlist-vis-row').count()) === 0 && (await frame.locator('.newlist-form input').count()) === 1);
    await frame.locator('.newlist-form input').click();
    await page.keyboard.type('Favourites', { delay: 20 });
    await page.keyboard.press('Enter');
    st = await until(async () => { const s = await booksState(frame); return s && s.lists.length === 1 ? s : null; }, 10000);
    check('lists: Enter makes the list', !!st && st.lists[0].name === 'Favourites', st);
    check('lists: its entry in the side bar has no visibility badge, and the page has no privacy button', (await frame.locator('.side-item', { hasText: 'Favourites' }).locator('.vis-badge').count()) === 0 && !(await frame.locator('.privacy-pill').first().isVisible().catch(() => false)));
    // making a list shows that (empty) list; go back to all the books, as a person would, and open one
    check('lists: the new list is shown, and is empty', (await frame.locator('.book-tile').count()) === 0);
    await clickEl(page, frame.locator('.side-item', { hasText: 'All Books' }));
    await clickEl(page, frame.locator('.book-tile', { hasText: 'Piranesi' }));
    await until(async () => (await frame.locator('.detail-title').innerText().catch(() => '')) === 'Piranesi', 6000);
    const openTitle = await frame.locator('.detail-title').innerText();
    await clickEl(page, frame.locator('.chip-row .btn', { hasText: 'Favourites' }));
    st = await until(async () => { const s = await booksState(frame); return s && s.lists[0].entries === 1 ? s : null; }, 8000);
    check('lists: a book is put into the list from its page (the chip says only the list\'s name)', !!st && (await frame.locator('.chip-row .btn', { hasText: 'Favourites' }).innerText()) === 'Favourites', { st, openTitle });

    // sharing is a host's, and says so
    const shareTry = await frame.evaluate(({ libId }) => new Promise((res) => {
      const fc = lively.identity.fileCrypto, h = lively.identity.did.currentUser().handle;
      fc.shareFolder(h, libId, [], (e1) => fc.setFolderVisibility(h, libId, 'private', {}, (e2) => fc.revokeFolderRecipient(h, libId, 'did:keo:x', (e3) => fc.createFolder('Shared', { recipients: [{ did: 'did:keo:x', x25519PublicKey: 'x' }] }, (e4) => res([e1, e2, e3, e4].map((e) => e && e.message))))));
    }), { libId: lib1 });
    check('sharing: sharing, changing a folder\'s visibility, revoking and making a shared folder all say they need a host', shareTry.every((m) => /Sharing needs a host/.test(m || '')), shareTry);

    // ---- 3. close the world and open it again
    await sleep(1500);
    await keoCall(frame, 'world.go', { kind: 'homestar' }).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    await keoCall(frame, 'world.go', { kind: 'world', name: 'Reading' }).catch(() => {});
    frame = await waitForWorld(page, 'world', 'Reading');
    st = await until(async () => { const s = await booksState(frame); return s && s.loaded && s.books.length === 2 ? s : null; }, 30000);
    check('reopen: the same two books are on the shelves, with their shelf and rating', !!st && st.books.find((b) => /Left Hand/.test(b.title)).shelf === 'reading' && st.books.find((b) => /Left Hand/.test(b.title)).rating === 4, st);
    check('reopen: the same library is used (no second one was made), and the list and its book are back', !!st && st.lib === lib1 && st.lists.length === 1 && st.lists[0].entries === 1, st);
    const docsNow = await rawDocs(page);
    check('reopen: the store holds exactly the library, two books and the list (no orphans)', docsNow.length === 4, docsNow.map((d) => d.id));

    // delete a book from its page
    await clickEl(page, frame.locator('.book-tile', { hasText: 'Piranesi' }));
    await until(async () => (await frame.locator('.detail-title').innerText().catch(() => '')) === 'Piranesi', 6000);
    await clickEl(page, frame.locator('.delete-row button'));
    st = await until(async () => { const s = await booksState(frame); return s && s.books.length === 1 ? s : null; }, 8000);
    check('delete: "Delete book" removes it from the shelf and from the list', !!st && st.books[0].title !== 'Piranesi' && st.lists[0].entries === 0, st);
    await sleep(1500);
    await keoCall(frame, 'world.go', { kind: 'homestar' }).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    await keoCall(frame, 'world.go', { kind: 'world', name: 'Reading' }).catch(() => {});
    frame = await waitForWorld(page, 'world', 'Reading');
    st = await until(async () => { const s = await booksState(frame); return s && s.loaded ? s : null; }, 30000);
    check('delete: after another reopen it is still gone', !!st && st.books.length === 1 && st.books[0].title === 'The Left Hand of Darkness', st);
    await page.screenshot({ path: path.join(WORK, 'books-after.png') });

    // ---- 3b. Books: the online search is a button, and what is added from it is kept on this device
    check('online: nothing was sent to an outside catalogue while Books was used by hand', outside.length === 0, outside);
    await clickEl(page, frame.locator('.hdr-addbtn'));
    await frame.locator('.add-box input').nth(0).click();
    await page.keyboard.type('Dune', { delay: 20 });
    await sleep(900);
    check('online: typing the title sends nothing (a search is made only by pressing the button)', outside.length === 0, outside);
    check('online: the box says where the text would go, and the button is there', /openlibrary\.org/.test(await frame.locator('.add-hint').innerText()) && (await frame.locator('.add-box button[title*="openlibrary.org"]').isEnabled()));
    await clickEl(page, frame.locator('.add-box button[title*="openlibrary.org"]'));
    await until(async () => (await frame.locator('.add-result', { hasText: 'Frank Herbert' }).count()) === 1, 15000);
    check('online: pressing it asks the catalogue once, with what was typed', outside.length === 1 && /openlibrary\.org\/search\.json\?q=Dune/.test(outside[0]), outside);
    check('online: what it found is shown beside the typed title, naming where it came from', /^via .+/.test(await frame.locator('.add-result-src').innerText()));
    await clickEl(page, frame.locator('.add-result', { hasText: 'Frank Herbert' }).locator('.btn-primary'));
    st = await until(async () => { const s = await booksState(frame); return s && s.books.length === 2 ? s : null; }, 10000);
    const dune = st && st.books.find((b) => b.title === 'Dune');
    check('online: "Add" on a result adds the book, not public', !!dune && dune.author === 'Frank Herbert' && dune.isPublic === false, st);
    const duneDoc = dune ? await lib(page, 'get', { objId: dune.objId }) : null;
    check('online: and its details are copied into the store on this device', !!duneDoc && duneDoc.r.record.payload.isbn === '9780441013593' && duneDoc.r.record.payload.coverSource === 'openlibrary' && duneDoc.r.did === DID, duneDoc && duneDoc.r);
    check('online: nothing else was asked of the catalogue', outside.length === 1, outside);

    // ---- 6. Music
    await keoCall(frame, 'world.go', { kind: 'homestar' }).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    await keoCall(frame, 'world.go', { kind: 'blank', name: 'Listening', template: 'music' }).catch(() => {});
    frame = await waitForWorld(page, 'blank', 'Listening');
    let ms = await until(async () => { const s = await musicState(frame); return s && s.loaded ? s : null; }, 30000);
    check('music: the app opens in a world made from the preset, with its library made on this device', !!ms && ms.owner === true && !!ms.lib && ms.handle === DID, ms);
    check('music: the header names no handle (the identity is not one) and has no public/private library button', !!ms && !/@|did:keo/.test(ms.sub) && ms.libBtn === 'none', ms);
    const lib2 = ms && ms.lib;
    const savedM = await until(async () => { const d = (await keoCall(frame, 'world.load', { name: 'Listening' })).r; return d && d.doc && d.doc.indexOf(lib2) >= 0 ? d : null; }, 20000);
    check('music: the saved world remembers its library', !!savedM);
    const base = outside.length;
    await clickEl(page, frame.locator('button', { hasText: 'Add music' }).first());
    await until(async () => (await frame.locator('.dlg input:visible').count()) >= 3, 6000);
    check('music: "Add music" offers to type an album: title, artist, year and tracks', (await frame.locator('.dlg input:visible').first().getAttribute('placeholder')) === 'Album title…' && (await frame.locator('.dlg textarea:visible').count()) === 1);
    await frame.locator('.dlg input:visible').nth(0).click();
    await page.keyboard.type('Blue Train', { delay: 20 });
    await frame.locator('.dlg input:visible').nth(1).click();
    await page.keyboard.type('John Coltrane', { delay: 20 });
    await frame.locator('.dlg input:visible').nth(2).click();
    await page.keyboard.type('1958', { delay: 20 });
    await frame.locator('.dlg textarea:visible').click();
    await page.keyboard.type('Blue Train\nLocomotion\nIm Old Fashioned', { delay: 10 });
    await sleep(900);
    check('music: typing sends nothing to the catalogue; the box says where Search online would send it', outside.length === base && /itunes\.apple\.com/.test(await frame.locator('.dlg:visible').innerText()), outside.slice(base));
    await clickEl(page, frame.locator('.dlg:visible button', { hasText: 'Listened' }));
    ms = await until(async () => { const s = await musicState(frame); return s && s.albums.length === 1 ? s : null; }, 10000);
    check('music: filing it on "Listened" adds the album with its three tracks, not public', !!ms && ms.albums[0].title === 'Blue Train' && ms.albums[0].artist === 'John Coltrane' && ms.albums[0].year === 1958 && ms.albums[0].shelf === 'listened' && ms.albums[0].tracks === 3 && ms.albums[0].isPublic === false, ms);
    const trainDoc = ms && ms.albums[0] ? await lib(page, 'get', { objId: ms.albums[0].objId }) : null;
    check('music: the album is in the sealed store, as an album of this identity', !!trainDoc && trainDoc.ok && trainDoc.r.type === 'album' && trainDoc.r.did === DID && trainDoc.r.record.payload.tracks.length === 3, trainDoc);
    check('music: nothing went to the catalogue', outside.length === base, outside.slice(base));
    await clickEl(page, frame.getByText('Blue Train', { exact: true }).first());
    await until(async () => (await frame.getByText('Added by hand').count()) > 0, 6000);
    check('music: the album opens; it says it was added by hand, and there is no Reviews & notes', (await frame.getByText('Added by hand · 3 tracks').count()) === 1 && !(await frame.getByText('Reviews & notes').first().isVisible().catch(() => false)));
    await clickEl(page, frame.getByLabel('Rate 4 stars'));
    ms = await until(async () => { const s = await musicState(frame); return s && s.albums[0].rating === 4 ? s : null; }, 8000);
    check('music: a rating of four stars is kept', !!ms, ms);
    await clickEl(page, frame.locator('.dlg-x:visible').first());

    // a playlist: no visibility to choose, a typed track
    await clickEl(page, frame.getByLabel('New playlist'));
    await until(async () => (await frame.locator('input[placeholder="e.g. Rainy day"]').count()) === 1, 5000);
    const plForm = frame.locator('input[placeholder="e.g. Rainy day"]').locator('xpath=ancestor::div[1]');
    check('playlists: the new playlist form asks for a name only: no visibility to choose, no sharing hint', (await plForm.locator('button', { hasText: /Private|Public/ }).count()) === 0 && !/Share with specific people/.test(await plForm.innerText()), await plForm.innerText());
    await frame.locator('input[placeholder="e.g. Rainy day"]').click();
    await page.keyboard.type('Focus', { delay: 20 });
    await page.keyboard.press('Enter');
    ms = await until(async () => { const s = await musicState(frame); return s && s.playlists.length === 1 ? s : null; }, 10000);
    check('playlists: Enter makes it, private to this device', !!ms && ms.playlists[0].name === 'Focus' && ms.playlists[0].visibility === 'private', ms);
    check('playlists: its page has no visibility button', (await frame.locator('button.vis').count()) === 0);
    await frame.locator('input[placeholder="Track title"]').click();
    await page.keyboard.type('So What', { delay: 20 });
    await frame.locator('input[placeholder="Artist"]').click();
    await page.keyboard.type('Miles Davis', { delay: 20 });
    await page.keyboard.press('Enter');
    ms = await until(async () => { const s = await musicState(frame); return s && s.playlists[0].entries.length === 1 ? s : null; }, 10000);
    check('playlists: a typed track is added with Enter', !!ms && ms.playlists[0].entries[0] === 'So What', ms);
    const plDoc = ms ? await lib(page, 'get', { objId: ms.playlists[0].objId }) : null;
    check('playlists: and it is in the playlist folder in the store', !!plDoc && plDoc.r.type === 'folder' && plDoc.r.record.payload.files.some((f) => f.type === 'track' && f.title === 'So What' && f.artist === 'Miles Davis'), plDoc && plDoc.r && plDoc.r.record.payload);

    // an album found in the catalogue, by pressing the button
    await clickEl(page, frame.locator('button', { hasText: 'Add music' }).first());
    await until(async () => (await frame.locator('.dlg input:visible').count()) >= 3, 6000);
    await frame.locator('.dlg input:visible').nth(0).click();
    await page.keyboard.type('Kind of Blue', { delay: 20 });
    await sleep(900);
    check('catalogue: typing the title sends nothing', outside.length === base, outside.slice(base));
    await clickEl(page, frame.locator('.dlg:visible button', { hasText: 'Search online' }));
    await until(async () => (await frame.locator('.dlg:visible', { hasText: 'Miles Davis' }).count()) > 0 && (await frame.locator('.dlg:visible button.sm', { hasText: 'Add' }).count()) > 0, 20000);
    await until(async () => outside.length >= base + 2, 10000);   // the song search follows the album search, paced apart
    check('catalogue: pressing it asks the catalogue for albums and songs, with what was typed', outside.length === base + 2 && outside.slice(base).every((u) => /itunes\.apple\.com\/search\?term=Kind%20of%20Blue/.test(u)), outside.slice(base));
    await clickEl(page, frame.locator('.dlg:visible button.sm', { hasText: 'Add' }).first());
    await clickEl(page, frame.locator('.dlg:visible button', { hasText: 'Listening' }).last());
    ms = await until(async () => { const s = await musicState(frame); return s && s.albums.length === 2 ? s : null; }, 20000);
    const kob = ms && ms.albums.find((a) => a.title === 'Kind of Blue');
    check('catalogue: adding it keeps a copy on this device, with its tracklist, not public', !!kob && kob.itunes === '111' && kob.src === 'itunes' && kob.tracks === 2 && kob.isPublic === false && kob.shelf === 'listening', ms);
    check('catalogue: only the search (two requests) and the tracklist lookup (one) went out', outside.length === base + 3 && /itunes\.apple\.com\/lookup\?id=111/.test(outside[outside.length - 1]), outside.slice(base));

    // close the world and open it again
    await sleep(1500);
    await keoCall(frame, 'world.go', { kind: 'homestar' }).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    await keoCall(frame, 'world.go', { kind: 'world', name: 'Listening' }).catch(() => {});
    frame = await waitForWorld(page, 'world', 'Listening');
    ms = await until(async () => { const s = await musicState(frame); return s && s.loaded && s.albums.length === 2 ? s : null; }, 30000);
    check('music reopen: both albums, the rating and the playlist with its track are back, in the same library', !!ms && ms.lib === lib2 && ms.albums.find((a) => a.title === 'Blue Train').rating === 4 && ms.playlists.length === 1 && ms.playlists[0].entries.length === 1, ms);
    await page.screenshot({ path: path.join(WORK, 'music-after.png') });
    check('music: after all this, still nothing was asked of a host', requests.length === 0, requests);

    // ---- 4. nothing went to a host
    console.log('INFO font requests made by the pages: ' + JSON.stringify(Array.from(fonts)));
    const resources = await frame.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name).filter((n) => /\/@did:|\/nodejs\/|\/dids\/|\/blobs\//.test(n)));
    check('no host: no request to a host route was made while using Books and Music', requests.length === 0 && resources.length === 0, { requests, resources });
    check('no errors came from the page', errors.length === 0, errors);

    // ---- 5. removing the identity removes its library
    const before = (await rawDocs(page)).length;
    await page.evaluate((d) => window.keoLibrary.purge(d), DID);
    check('purge: what the apps made is removed with the identity', before > 8 && (await rawDocs(page)).length === 0, before);
  } catch (e) {
    check('the run finished', false, e.stack || String(e));
  } finally {
    await ctx.close().catch(() => {});
  }
  console.log(failed ? failed + ' check(s) FAILED' : 'all checks passed');
  process.exit(failed ? 1 : 0);
})();
