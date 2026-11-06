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
    const outsideFrame = [];      // [address, the page that made the request] for each
    const outside = [];           // requests to the public catalogues (answered by the mock below, never by the real ones)
    const fonts = new Set();
    const faceFiles = [];         // the font files the pages did load: where from
    page.on('request', (r) => { if (/\.woff2(\?|$)/.test(r.url()) && /app-fonts/.test(r.url())) faceFiles.push(r.url()); });
    page.on('request', (r) => { if (/^https:\/\/(openlibrary\.org|covers\.openlibrary\.org|itunes\.apple\.com|is1-ssl\.mzstatic\.com|musicbrainz\.org|coverartarchive\.org)\//.test(r.url())) { outside.push(r.url()); outsideFrame.push([r.url(), r.frame().url()]); } });
    page.on('request', (r) => { if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) fonts.add(new URL(r.url()).host); else if (hostish.test(r.url())) requests.push(r.url()); });
    // The public catalogues are answered here, so the test needs no network and says exactly what was asked of them.
    const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await ctx.route(/^https:\/\/(openlibrary\.org|covers\.openlibrary\.org|itunes\.apple\.com|is1-ssl\.mzstatic\.com|musicbrainz\.org|coverartarchive\.org)\//, (route) => {
      const u = new URL(route.request().url());
      if (u.hostname === 'coverartarchive.org') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'image/png' }, body: PNG });
      if (u.hostname === 'musicbrainz.org') return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ releases: [{ id: 'aaaaaaaa-0000-0000-0000-000000000001' }, { id: 'aaaaaaaa-0000-0000-0000-000000000002' }] }) });
      if (/\.(jpg|png)$/.test(u.pathname)) return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'image/png' }, body: PNG });
      let body = {};
      if (u.hostname === 'openlibrary.org') body = { docs: [{ title: 'Dune', author_name: ['Frank Herbert'], isbn: ['9780441013593'], cover_i: 123 }] };
      else if (u.pathname === '/search' && u.searchParams.get('entity') === 'album') body = { results: [{ wrapperType: 'collection', collectionId: 111, collectionName: 'Kind of Blue', artistName: 'Miles Davis', releaseDate: '1959-08-17T07:00:00Z', artworkUrl100: 'https://is1-ssl.mzstatic.com/art/100x100bb.jpg', trackCount: 2, collectionViewUrl: 'https://music.invalid/album/111' }] };
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

    // ---- 1b. files (blobs): kept by their hash, sealed, limited
    const sha = (bytes) => page.evaluate(async (b) => window.keoDid.b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b)))), Array.from(bytes));
    const blob = (fn, args) => page.evaluate(([f, a]) => window.keoLibrary[f](a).then((r) => ({ ok: true, r: r instanceof ArrayBuffer ? Array.from(new Uint8Array(r)) : r }), (e) => ({ ok: false, e: e.message })), [fn, args]);
    const putB = (cid, arr) => page.evaluate(([c, a]) => window.keoLibrary.putBlob({ cid: c, bytes: new Uint8Array(a).buffer }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [cid, Array.from(arr)]);
    const secret = Array.from(Buffer.from('PNGSECRETMARK-the-picture-of-a-private-book'));
    const cidA = await sha(secret);
    check('files: the id is the base64url SHA-256, 43 characters', /^[A-Za-z0-9_-]{43}$/.test(cidA), cidA);
    check('files: a file that was never put is null', (await blob('getBlob', { cid: cidA })).r === null);
    check('files: put says true', (await putB(cidA, secret)).r === true);
    const gotA = await blob('getBlob', { cid: cidA });
    check('files: what comes back is what went in', gotA.ok && JSON.stringify(gotA.r) === JSON.stringify(secret), gotA);
    r = await putB(cidA, [1, 2, 3]);
    check('files: an id that is not the hash of the bytes is refused', !r.ok && /hash of its bytes/.test(r.e), r);
    r = await putB('short', secret);
    check('files: an id that is not 43 characters of the id alphabet is refused', !r.ok && /valid file id/.test(r.e), r);
    r = await blob('putBlob', { cid: cidA, bytes: 'not bytes' });
    check('files: something that is not bytes is refused', !r.ok && /must be bytes/.test(r.e), r);
    const bigCid = await page.evaluate(async () => { const big = new Uint8Array(25 * 1024 * 1024 + 1); window.__big = big; return window.keoDid.b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', big))); });
    r = await page.evaluate((c) => window.keoLibrary.putBlob({ cid: c, bytes: window.__big }).then((x) => ({ ok: true, r: x }), (e) => ({ ok: false, e: e.message })), bigCid);
    check('files: a file over 25 MB is refused', !r.ok && /at most 25 MB/.test(r.e), r);
    await putB(cidA, secret);
    const blobRaw = () => page.evaluate(() => new Promise((res) => { const q = indexedDB.open('keo-library'); q.onsuccess = () => { const db = q.result, t = db.transaction(['blobs', 'blobtotal']); const a = t.objectStore('blobs').getAll(), b = t.objectStore('blobtotal').getAll(); t.oncomplete = () => { db.close(); res({ blobs: a.result.map((x) => ({ id: x.id, did: x.did, iv: x.iv, ct: Array.from(x.ct) })), totals: b.result }); }; }; }));
    let br = await blobRaw();
    check('files: the same bytes put twice are kept once, and counted once', br.blobs.length === 1 && br.totals.length === 1 && br.totals[0].total === secret.length, br.totals);
    check('files: nothing of the file can be read from disk, and its record names only the identity, the id, an iv and sealed bytes', Object.keys(br.blobs[0]).sort().join() === 'ct,did,id,iv' && !/PNGSECRETMARK/.test(String.fromCharCode.apply(null, br.blobs[0].ct)) && br.blobs[0].ct.length === secret.length + 16, br.blobs[0].ct.length);
    await page.evaluate(([id]) => new Promise((res) => { const q = indexedDB.open('keo-library'); q.onsuccess = () => { const db = q.result, t = db.transaction('blobs', 'readwrite'), st = t.objectStore('blobs'); const g = st.get(id); g.onsuccess = () => { const v = g.result; v.ct[2] ^= 1; st.put(v); }; t.oncomplete = () => { db.close(); res(); }; }; }), [DID + '|' + cidA]);
    r = await blob('getBlob', { cid: cidA });
    check('files: a file with one changed byte is refused', !r.ok && /could not be decrypted/.test(r.e), r);
    await blob('removeBlob', { cid: cidA });
    await putB(cidA, secret);
    // a record copied under another id is refused (the id is part of what is sealed)
    const cidB = await sha([9, 9, 9]);
    await page.evaluate(([from, to, did]) => new Promise((res) => { const q = indexedDB.open('keo-library'); q.onsuccess = () => { const db = q.result, t = db.transaction('blobs', 'readwrite'), st = t.objectStore('blobs'); const g = st.get(from); g.onsuccess = () => { const v = g.result; st.put({ id: to, did: did, iv: v.iv, ct: v.ct }); }; t.oncomplete = () => { db.close(); res(); }; }; }), [DID + '|' + cidA, DID + '|' + cidB, DID]);
    r = await blob('getBlob', { cid: cidB });
    check('files: a file record copied under another id is refused', !r.ok && /could not be decrypted/.test(r.e), r);
    await page.evaluate(([id]) => new Promise((res) => { const q = indexedDB.open('keo-library'); q.onsuccess = () => { const db = q.result, t = db.transaction('blobs', 'readwrite'); t.objectStore('blobs').delete(id); t.oncomplete = () => { db.close(); res(); }; }; }), [DID + '|' + cidB]);
    check('files: removing one says true, then it is gone, and removing it again says false', (await blob('removeBlob', { cid: cidA })).r === true && (await blob('getBlob', { cid: cidA })).r === null && (await blob('removeBlob', { cid: cidA })).r === false);
    br = await blobRaw();
    check('files: and the running total is back to nothing', br.blobs.length === 0 && br.totals[0].total === 0, br.totals);
    // the total limit: set the running total just under it, then put a file that does not fit
    await page.evaluate(([did]) => new Promise((res) => { const q = indexedDB.open('keo-library'); q.onsuccess = () => { const db = q.result, t = db.transaction('blobtotal', 'readwrite'); t.objectStore('blobtotal').put({ did: did, total: 1024 * 1024 * 1024 - 10 }); t.oncomplete = () => { db.close(); res(); }; }; }), [DID]);
    r = await putB(cidA, secret);
    check('files: when the identity\'s files would pass 1 GB together the put is refused', !r.ok && /library is full/.test(r.e), r);
    await page.evaluate(([did]) => new Promise((res) => { const q = indexedDB.open('keo-library'); q.onsuccess = () => { const db = q.result, t = db.transaction('blobtotal', 'readwrite'); t.objectStore('blobtotal').put({ did: did, total: 0 }); t.oncomplete = () => { db.close(); res(); }; }; }), [DID]);
    // through the bridge, as the apps do (an ArrayBuffer made in the world)
    const viaBridgeB = await frame.evaluate(async () => { const b = new Uint8Array([5, 6, 7, 8]); const cid = lively.identity.crypto.base64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', b))); const put = await window.keo.call('library.blobPut', { cid: cid, bytes: b.buffer }, 30000).then((r) => r, (e) => e.message); const got = await window.keo.call('library.blobGet', { cid: cid }, 30000).then((r) => Array.from(new Uint8Array(r)), (e) => e.message); const rm = await window.keo.call('library.blobRemove', { cid: cid }, 30000).then((r) => r, (e) => e.message); return { put, got, rm }; });
    check('bridge: the world puts, gets and removes a file, and the hash the runtime makes is the one the shell checks', viaBridgeB.put === true && JSON.stringify(viaBridgeB.got) === '[5,6,7,8]' && viaBridgeB.rm === true, viaBridgeB);
    await putB(cidA, secret);

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
    br = await blobRaw();
    check('purge: removing the identity\'s library leaves nothing, files and running total included, found by the identity and needing no key', (await rawDocs(page)).length === 0 && (await lib(page, 'get', { objId: idB })).r === null && br.blobs.length === 0 && br.totals.length === 0, br);

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

    // three changes to different fields of one book in the same instant must all be kept (each save reads the book before it writes)
    await frame.evaluate(() => { const m = $world.submorphs.find((x) => x.name === 'Books'); m._patchCurrentBook({ shelf: 'read' }); m._patchCurrentBook({ rating: 5 }); m._patchCurrentBook({ description: 'Gethen' }); });
    const rapid = await until(async () => { const d = await lib(page, 'get', { objId: bookId }); const pl = d.r && d.r.record.payload; return pl && pl.shelf === 'read' && pl.rating === 5 && pl.description === 'Gethen' ? pl : null; }, 8000);
    check('books: three changes made at once to one book are all kept (the saves wait for each other)', !!rapid, (await lib(page, 'get', { objId: bookId })).r.record.payload);

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
    check('reopen: the same two books are on the shelves, with their shelf and rating', !!st && st.books.find((b) => /Left Hand/.test(b.title)).shelf === 'read' && st.books.find((b) => /Left Hand/.test(b.title)).rating === 5, st);
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
    check('online: pressing it asks the catalogue for a search once, with what was typed (and the results show its thumbnail, as a search is meant to)', outside.filter((u) => /openlibrary\.org\/search\.json\?q=Dune/.test(u)).length === 1 && outside.every((u) => /search\.json|covers\.openlibrary\.org/.test(u)), outside);
    check('online: what it found is shown beside the typed title, naming where it came from', /^via .+/.test(await frame.locator('.add-result-src').innerText()));
    await clickEl(page, frame.locator('.add-result', { hasText: 'Frank Herbert' }).locator('.btn-primary'));
    st = await until(async () => { const s = await booksState(frame); return s && s.books.length === 2 ? s : null; }, 10000);
    const dune = st && st.books.find((b) => b.title === 'Dune');
    check('online: "Add" on a result adds the book, not public', !!dune && dune.author === 'Frank Herbert' && dune.isPublic === false, st);
    const duneDoc = dune ? await lib(page, 'get', { objId: dune.objId }) : null;
    check('online: and its details are copied into the store on this device', !!duneDoc && duneDoc.r.record.payload.isbn === '9780441013593' && duneDoc.r.record.payload.coverSource === 'openlibrary' && duneDoc.r.did === DID, duneDoc && duneDoc.r);
    check('online: the book\'s picture was copied on adding (a second request for it after the thumbnail), and stored sealed on this device, and the catalogue\'s address is not kept', outside.length === 3 && outside.filter((u) => /covers\.openlibrary\.org\/b\/id\/123-M\.jpg/.test(u)).length === 2 && !!duneDoc && /^[A-Za-z0-9_-]{43}$/.test(duneDoc.r.record.payload.coverBlob || '') && duneDoc.r.record.payload.coverMime === 'image/png' && duneDoc.r.record.payload.coverUrl === null && !/https?:/.test(JSON.stringify(duneDoc.r)), { outside, payload: duneDoc && duneDoc.r.record.payload });
    const coverBytes = duneDoc ? await blob('getBlob', { cid: duneDoc.r.record.payload.coverBlob }) : null;
    check('online: the copy in the store is the picture the catalogue sent', !!coverBytes && coverBytes.ok && Array.from(PNG).join() === coverBytes.r.join(), coverBytes && coverBytes.r && coverBytes.r.length);
    const duneCover = await frame.evaluate(() => { const m = $world.submorphs.find((x) => x.name === 'Books'); const b = m.state.books.find((x) => x.title === 'Dune'); const tile = Array.from(document.querySelectorAll('.book-tile')).find((t) => /Dune/.test(t.innerText)); return { url: b.coverUrl, bg: tile ? tile.querySelector('.book-cover').style.backgroundImage : null }; });
    check('online: the book is drawn from that copy (a local address), not from the catalogue', /^blob:/.test(duneCover.url || '') && /blob:/.test(duneCover.bg || ''), duneCover);

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
    const loadedFaces = await frame.evaluate(() => document.fonts.ready.then(() => Array.from(document.fonts).filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, ''))));
    check('fonts: the faces Music uses are loaded, from the package (DM Sans or Bricolage Grotesque)', loadedFaces.some((f) => /DM Sans|Bricolage Grotesque/.test(f)), loadedFaces);
    await sleep(500);
    check('fonts: and they were read from files of the package itself', faceFiles.length > 0 && faceFiles.every((n) => /^chrome-extension:\/\//.test(n)), faceFiles);
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
    await until(async () => outside.slice(base).filter((u) => /itunes\.apple\.com\/search/.test(u)).length >= 2, 10000);   // the song search follows the album search, paced apart
    check('catalogue: pressing it asks the catalogue for albums and for songs, with what was typed', outside.slice(base).filter((u) => /itunes\.apple\.com\/search\?term=Kind%20of%20Blue&entity=(album|song)/.test(u)).length === 2 && outside.slice(base).every((u) => /itunes\.apple\.com\/search|mzstatic/.test(u)), outside.slice(base));
    await clickEl(page, frame.locator('.dlg:visible button.sm', { hasText: 'Add' }).first());
    await clickEl(page, frame.locator('.dlg:visible button', { hasText: 'Listening' }).last());
    ms = await until(async () => { const s = await musicState(frame); return s && s.albums.length === 2 ? s : null; }, 20000);
    const kob = ms && ms.albums.find((a) => a.title === 'Kind of Blue');
    check('catalogue: adding it keeps a copy on this device, with its tracklist, not public', !!kob && kob.itunes === '111' && kob.src === 'itunes' && kob.tracks === 2 && kob.isPublic === false && kob.shelf === 'listening', ms);
    const mine = outside.slice(base);
    check('catalogue: only the two searches, the tracklist lookup, and the album\'s picture (the result row\'s thumbnail, then the copy) went out', mine.length === 5 && mine.filter((u) => /itunes\.apple\.com\/search/.test(u)).length === 2 && mine.filter((u) => /itunes\.apple\.com\/lookup\?id=111/.test(u)).length === 1 && mine.filter((u) => /is1-ssl\.mzstatic\.com\/art\/300x300bb\.jpg/.test(u)).length === 2, mine);
    const kobDoc = kob ? await lib(page, 'get', { objId: kob.objId }) : null;
    check('catalogue: the album keeps its picture on this device and the catalogue\'s address is not kept anywhere in it', !!kobDoc && /^[A-Za-z0-9_-]{43}$/.test(kobDoc.r.record.payload.coverBlob || '') && kobDoc.r.record.payload.coverUrl === null && !/mzstatic/.test(JSON.stringify(kobDoc.r)), kobDoc && kobDoc.r.record.payload);
    check('catalogue: and it is drawn from that copy', await frame.evaluate(() => { const m = $world.submorphs.find((x) => x.name === 'Music'); const a = m.state.albums.find((x) => x.title === 'Kind of Blue'); return /^blob:/.test(a.coverUrl || ''); }));
    // tracks added to a playlist from the catalogue keep their picture on the device too (the same picture is stored once)
    const plTrack = await frame.evaluate(() => new Promise((res) => { const m = $world.submorphs.find((x) => x.name === 'Music'); const pl = m.state.playlists[0]; m._addTracksToPlaylist(pl, [{ title: 'Freddie Freeloader', artist: 'Miles Davis', albumTitle: 'Kind of Blue', coverUrl: 'https://is1-ssl.mzstatic.com/art/300x300bb.jpg', previewUrl: 'https://is1-ssl.mzstatic.com/p.m4a', durationMs: 1000, ids: { itunes: '223' } }], () => res(pl.entries.map((e) => ({ title: e.title, url: e.coverUrl })))); }));
    check('catalogue: a track added to a playlist is drawn from a local copy of its picture', plTrack.length === 2 && /^blob:/.test((plTrack.find((e) => e.title === 'Freddie Freeloader') || {}).url || ''), plTrack);
    const plDoc2 = await lib(page, 'get', { objId: (await musicState(frame)).playlists[0].objId });
    const trackRec = plDoc2.r.record.payload.files.find((f) => f.title === 'Freddie Freeloader');
    check('catalogue: and the playlist keeps only the copy\'s id, not the address', !!trackRec && trackRec.coverUrl === null && trackRec.coverBlob === kobDoc.r.record.payload.coverBlob && !/mzstatic\.com\/art/.test(JSON.stringify(plDoc2.r)), trackRec);
    let picturesAfter = outside.length;

    // the catalogue is read by the shell page (it alone has the manifest permission); the world cannot use it for anything else
    const itunesFrames = outsideFrame.filter(([u]) => /itunes\.apple\.com\/(search|lookup)/.test(u));
    check('catalogue: the music catalogue was read by the shell page, not by the world (that site refuses the world\'s origin)', itunesFrames.length === 3 && itunesFrames.every(([, f]) => /\/start\.html$/.test(f)), itunesFrames);
    const pictureFrames = outsideFrame.filter(([u]) => /mzstatic/.test(u));
    check('catalogue: the pictures are read by the world itself (their host sends the permission), never by the shell', pictureFrames.length > 0 && pictureFrames.every(([, f]) => /\/world\.html$/.test(f)), pictureFrames);
    const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
    check('manifest: the one host permission is the music catalogue, and there is no other permission', JSON.stringify(manifest.host_permissions) === JSON.stringify(['https://itunes.apple.com/*']) && !manifest.permissions, { host: manifest.host_permissions, permissions: manifest.permissions });
    const beforeRefusals = outside.length;
    const refused = ['http://itunes.apple.com/search?term=a', 'https://itunes.apple.com.evil.example/search?term=a', 'https://example.com/search?term=a', 'https://itunes.apple.com/other?term=a', 'https://user:pw@itunes.apple.com/search?term=a', 'https://itunes.apple.com:8443/search?term=a', 'https://itunes.apple.com/search?term=a#x', 'https://itunes.apple.com/search?term=' + 'a'.repeat(700), 'itunes.apple.com/search', 42];
    const refusals = await page.evaluate((list) => Promise.all(list.map((u) => window.keoCatalog.get({ url: u }).then(() => 'allowed', (e) => e.message))), refused);
    check('catalogue: the shell refuses every address that is not a search or lookup of that one site over https, and sends nothing for them', refusals.every((m) => /not one the catalogue lookup may read|not a valid catalogue address/.test(m)) && outside.length === beforeRefusals, refusals);
    const worldAsks = await keoCall(frame, 'catalog.get', { url: 'https://example.com/search?term=a' });
    check('catalogue: the same refusal reaches the world through the bridge op', !worldAsks.ok && /not one the catalogue lookup may read/.test(worldAsks.e), worldAsks);
    const worldOk = await keoCall(frame, 'catalog.get', { url: 'https://itunes.apple.com/lookup?id=111&entity=song' });
    check('catalogue: and a lookup the world is allowed to ask for comes back as plain data', worldOk.ok && Array.isArray(worldOk.r.results), worldOk);
    picturesAfter = outside.length;     // the lookup just made is not part of showing pictures

    // close the world and open it again
    await sleep(1500);
    await keoCall(frame, 'world.go', { kind: 'homestar' }).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    await keoCall(frame, 'world.go', { kind: 'world', name: 'Listening' }).catch(() => {});
    frame = await waitForWorld(page, 'world', 'Listening');
    ms = await until(async () => { const s = await musicState(frame); return s && s.loaded && s.albums.length === 2 ? s : null; }, 30000);
    check('music reopen: both albums, the rating and the playlist with its two tracks are back, in the same library', !!ms && ms.lib === lib2 && ms.albums.find((a) => a.title === 'Blue Train').rating === 4 && ms.playlists.length === 1 && ms.playlists[0].entries.length === 2, ms);
    await sleep(1500);
    check('music reopen: the pictures are drawn from the copies, and nothing was asked of any catalogue to show them', outside.length === picturesAfter && await frame.evaluate(() => { const m = $world.submorphs.find((x) => x.name === 'Music'); return /^blob:/.test(m.state.albums.find((a) => a.title === 'Kind of Blue').coverUrl || '') && (() => { const withPic = m.state.playlists[0].entries.filter((e) => e.coverBlob); return withPic.length === 1 && withPic.every((e) => /^blob:/.test(e.coverUrl || '')); })(); }), outside.slice(picturesAfter));
    await page.screenshot({ path: path.join(WORK, 'music-after.png') });
    check('music: after all this, still nothing was asked of a host', requests.length === 0, requests);

    // Books again: its picture is drawn from the copy after the world is opened again, and nothing is asked of the catalogue for it
    await keoCall(frame, 'world.go', { kind: 'homestar' }).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    await keoCall(frame, 'world.go', { kind: 'world', name: 'Reading' }).catch(() => {});
    frame = await waitForWorld(page, 'world', 'Reading');
    st = await until(async () => { const x = await booksState(frame); return x && x.loaded && x.books.length === 2 ? x : null; }, 30000);
    await sleep(1500);
    const duneAgain = await frame.evaluate(() => { const m = $world.submorphs.find((x) => x.name === 'Books'); const b = m.state.books.find((x) => x.title === 'Dune'); const tile = Array.from(document.querySelectorAll('.book-tile')).find((t) => /Dune/.test(t.innerText)); return { url: b && b.coverUrl, bg: tile ? tile.querySelector('.book-cover').style.backgroundImage : null }; });
    check('books reopen: the book is drawn from the copy of its picture, and nothing was asked of any catalogue to show it', !!st && /^blob:/.test(duneAgain.url || '') && /blob:/.test(duneAgain.bg || '') && outside.length === picturesAfter, { duneAgain, extra: outside.slice(picturesAfter) });

    // ---- 3c. a cover for something added by typing: looked up only when a button is pressed, from services that need no key
    // Books (the world is open again): the typed book has no picture, the one from the catalogue has one
    await clickEl(page, frame.locator('.book-tile', { hasText: 'Dune' }));
    await until(async () => (await frame.locator('.detail-title').innerText().catch(() => '')) === 'Dune', 6000);
    check('find cover: a book that has a picture does not offer to find one', !(await frame.locator('.detail-cover-pane button', { hasText: 'Find a cover online' }).isVisible()));
    const closeDetail = () => clickEl(page, frame.locator('.detail-title').locator('xpath=ancestor::div[contains(@class,"detail-top")]').locator('.btn-ghost'));
    await closeDetail();
    await clickEl(page, frame.locator('.book-tile', { hasText: 'Left Hand' }));
    await until(async () => (await frame.locator('.detail-title').innerText().catch(() => '')) === 'The Left Hand of Darkness', 6000);
    const findBtn = frame.locator('.detail-cover-pane button', { hasText: 'Find a cover online' });
    check('find cover: the typed book offers it, and the button says where the title and author go', await findBtn.isVisible() && /openlibrary\.org/.test(await findBtn.getAttribute('title')));
    const beforeFind = outside.length;
    await sleep(800);
    check('find cover: having the book open sent nothing', outside.length === beforeFind, outside.slice(beforeFind));
    await clickEl(page, findBtn);
    const gotCover = await until(() => frame.evaluate(() => { const m = $world.submorphs.find((x) => x.name === 'Books'); const b = m.state.books.find((x) => /Left Hand/.test(x.title)); return b && b.coverBlob && /^blob:/.test(b.coverUrl || '') ? b.coverBlob : null; }), 15000);
    check('find cover: pressing it looks the title and author up once and copies the picture it finds', !!gotCover && outside.slice(beforeFind).filter((u) => /openlibrary\.org\/search\.json.*The%20Left%20Hand%20of%20Darkness%20Ursula/.test(u)).length === 1 && outside.slice(beforeFind).filter((u) => /covers\.openlibrary\.org/.test(u)).length === 1 && outside.length === beforeFind + 2, outside.slice(beforeFind));
    const lhDoc = await lib(page, 'get', { objId: bookId });
    check('find cover: the book keeps the copy, not an address', lhDoc.r.record.payload.coverBlob === gotCover && lhDoc.r.record.payload.coverUrl === null && !/https?:/.test(JSON.stringify(lhDoc.r.record.payload)), lhDoc.r.record.payload);
    check('find cover: and the button is gone now that it has a picture', await until(async () => !(await findBtn.isVisible()), 6000));
    await closeDetail();
    // Music: the typed album
    await keoCall(frame, 'world.go', { kind: 'homestar' }).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    await keoCall(frame, 'world.go', { kind: 'world', name: 'Listening' }).catch(() => {});
    frame = await waitForWorld(page, 'world', 'Listening');
    ms = await until(async () => { const x = await musicState(frame); return x && x.loaded && x.albums.length === 2 ? x : null; }, 30000);
    await clickEl(page, frame.getByText('Blue Train', { exact: true }).first());
    const albumFind = frame.locator('.dlg:visible button', { hasText: 'Find a cover online' });
    await until(async () => await albumFind.count() > 0, 6000);
    check('find cover: the typed album offers it, and the button says where the album and artist go', await albumFind.isVisible() && /musicbrainz\.org/.test(await albumFind.getAttribute('title')));
    const beforeAlbum = outside.length;
    await clickEl(page, albumFind);
    const gotAlbumCover = await until(() => frame.evaluate(() => { const m = $world.submorphs.find((x) => x.name === 'Music'); const a = m.state.albums.find((x) => x.title === 'Blue Train'); return a && a.coverBlob && /^blob:/.test(a.coverUrl || '') ? a.coverBlob : null; }), 15000);
    check('find cover: pressing it asks for the album once and then for a front cover, and copies the picture', !!gotAlbumCover && outside.slice(beforeAlbum).filter((u) => /musicbrainz\.org\/ws\/2\/release\/.*Blue%20Train/.test(u)).length === 1 && outside.slice(beforeAlbum).filter((u) => /coverartarchive\.org\/release\/aaaaaaaa-0000-0000-0000-000000000001\/front-250/.test(u)).length === 1 && outside.length === beforeAlbum + 2, outside.slice(beforeAlbum));
    const btAlbum = ms.albums.find((a) => a.title === 'Blue Train');
    await sleep(800);
    const btDoc = await lib(page, 'get', { objId: btAlbum.objId });
    check('find cover: the album keeps the copy, not an address', btDoc.r.record.payload.coverBlob === gotAlbumCover && btDoc.r.record.payload.coverUrl === null && !/https?:/.test(JSON.stringify(btDoc.r.record.payload)), btDoc.r.record.payload);
    check('find cover: and the button is gone from the album page', await until(async () => (await frame.locator('.dlg:visible button', { hasText: 'Find a cover online' }).count()) === 0, 6000));

    // ---- 4. nothing went to a host
    check('fonts: no page asked a font service for anything (Books and Music, from the first load to the last)', fonts.size === 0, Array.from(fonts));
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
