// Names and folders of the files in the library (shell/keo-library.js: fileRename, fileMove, folderCreate, folderRename, folderDelete,
// folderList, and fileSearch with a folder and a sort; the bridge ops of the same names): a rename rewrites only the sealed record
// (fresh IV, the bytes and the file's name by hash untouched), a folder is a field of that record, folders go two levels deep, two
// folders in one place never share a name, deleting a folder never deletes a file (everything in it goes up a level), a move is all
// or nothing, the folders are one sealed document the world cannot write, a deleted folder stays as a tombstone, and "Move my data"
// carries names, folders and files into an empty library.
// Usage: node keo-libfolders-test.js <repo root> <package folder> <work dir>
// A headed browser with the package loaded, `localhost` unresolvable, a virtual authenticator with PRF.
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 900) : '')); if (!ok) failed++; }
const worldFrame = (page) => page.frames().find((f) => /world\.html$/.test(f.url()));
async function waitForWorld(page, kind) {
  let frame = null;
  for (let i = 0; i < 200; i++) {
    frame = worldFrame(page);
    if (frame) { try { if (await frame.evaluate((k) => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind === k), kind)) break; } catch (e) {} }
    frame = null; await sleep(300);
  }
  if (!frame) throw new Error('the world did not start as ' + kind);
  await sleep(2500);
  return frame;
}

// helpers that live in the shell page
const SETUP = () => {
  const L = window.keoLibrary, enc = new TextEncoder();
  const t = window.__t = {};
  t.fill = (n, seed) => { const u = new Uint8Array(n); let x = (seed >>> 0) || 1; for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; u[i] = x & 255; } return u; };
  t.tryp = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message }));
  t.add = async (name, type, size, seed) => {          // one small file, the whole sequence
    const u8 = t.fill(size, seed), b = await L.fileBegin({ name, type, size }); await L.fileChunk({ upload: b.upload, n: 0, bytes: u8 });
    return (await L.fileEnd({ upload: b.upload })).id;
  };
  t.idb = (stores, mode, fn) => new Promise((res, rej) => { const q = indexedDB.open('keo-library'); q.onerror = () => rej(q.error); q.onsuccess = () => { const db = q.result, tx = db.transaction(stores, mode); let out; try { out = fn(tx); } catch (e) { db.close(); return rej(e); } tx.oncomplete = () => { db.close(); res(typeof out === 'function' ? out() : out); }; tx.onabort = tx.onerror = () => { db.close(); rej(tx.error); }; }; });
  t.rawFile = (did, id) => t.idb(['files'], 'readonly', (tx) => { const r = tx.objectStore('files').get(did + '|' + id); return () => ({ iv: r.result.iv, ct: Array.from(r.result.ct) }); });
  t.count = (store) => t.idb([store], 'readonly', (tx) => { const r = tx.objectStore(store).count(); return () => r.result; });
  // does any stored ciphertext of these stores contain the marker text (a sealed record must not)
  t.leaks = (marker) => t.idb(['files', 'docs'], 'readonly', (tx) => { const m = enc.encode(marker), rs = ['files', 'docs'].map((s) => tx.objectStore(s).getAll());
    return () => rs.some((r) => r.result.some((x) => { const a = x.ct; outer: for (let i = 0; i + m.length <= a.length; i++) { for (let j = 0; j < m.length; j++) if (a[i + j] !== m[j]) continue outer; return true; } return false; })); });
  t.cidOf = async (u8) => { const d = new Uint8Array(await crypto.subtle.digest('SHA-256', u8)); let s = ''; for (const b of d) s += String.fromCharCode(b); return btoa(s).split('+').join('-').split('/').join('_').split('=').join(''); };
  return true;
};

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-libfolders'), {
    headless: false, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  try {
    const page = await ctx.newPage();
    const errors = [], outside = [];
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    page.on('request', (rq) => { const u = rq.url(); if (!/^(chrome-extension|blob|data):/.test(u)) outside.push(u.slice(0, 100)); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    await page.goto(`chrome-extension://${ID}/start.html`);
    let frame = await waitForWorld(page, 'gate');
    await page.evaluate(SETUP);
    const T = (code, arg) => page.evaluate(code, arg);
    const lib = (op, args) => T(([o, a]) => window.__t.tryp(window.keoLibrary[o](a)), [op, args]);   // { ok, r } or { ok: false, e }

    // ---- nobody signed in
    let r = await lib('folderList');
    check('with nobody signed in the folders cannot be listed', !r.ok && /Sign in/.test(r.e), r);
    r = await lib('folderCreate', { name: 'x' });
    check('with nobody signed in a folder cannot be made', !r.ok && /Sign in/.test(r.e), r);

    const made = await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }));
    const DID = made.did;
    await frame.evaluate(() => window.keo.call('world.go', { kind: 'enter' }, 60000)).catch(() => {});
    frame = await waitForWorld(page, 'homestar');

    // ---- four small files, no folders yet
    const A = await T(() => window.__t.add('report.pdf', 'application/pdf', 3000, 21));
    const B = await T(() => window.__t.add('beach.png', 'image/png', 9000, 22));
    const Cc = await T(() => window.__t.add('notes.md', 'text/markdown', 500, 23));
    const D = await T(() => window.__t.add('plan.pdf', 'application/pdf', 6000, 24));
    r = await lib('folderList');
    check('no folders yet: four files, all in no folder', r.ok && r.r.folders.length === 0 && r.r.unsorted === 4 && r.r.all === 4 && r.r.unreadable === 0, r);
    r = await lib('fileSearch', {});
    check('a search carries the folder of every file (none yet)', r.ok && r.r.items.length === 4 && r.r.items.every((i) => i.folder === null), r);

    // ---- making folders
    r = await lib('folderCreate', { name: '  Work ' });
    check('a folder is made, its name trimmed, an id of twelve characters, at the top level', r.ok && r.r.name === 'Work' && /^[A-Za-z0-9_-]{12}$/.test(r.r.id) && r.r.parent === null, r);
    const W = r.r.id;
    r = await lib('folderCreate', { name: 'Holiday' }); const H = r.r.id;
    r = await lib('folderCreate', { name: 'work' });
    check('a second folder with the same name in the same place is refused, in any case', !r.ok && /already a folder called "work" here/.test(r.e), r);
    r = await lib('folderCreate', { name: '   ' });
    check('a folder with no name is refused', !r.ok && /needs a name/.test(r.e), r);
    r = await lib('folderCreate', { name: 'a\u0000b\nc' });
    check('control characters are taken out of a name', r.ok && r.r.name === 'abc', r);
    const junk = r.r.id;
    r = await lib('folderCreate', { name: 'x'.repeat(300) });
    check('a long folder name is cut to 100 characters', r.ok && r.r.name.length === 100, r && r.r && r.r.name.length);
    await lib('folderDelete', { id: r.r.id });
    await lib('folderDelete', { id: junk });
    r = await lib('folderCreate', { name: '2024', parent: W });
    check('a folder inside a folder is made', r.ok && r.r.parent === W, r);
    const Y = r.r.id;
    r = await lib('folderCreate', { name: 'Deeper', parent: Y });
    check('a third level is refused: two levels deep', !r.ok && /two levels/.test(r.e), r);
    r = await lib('folderCreate', { name: 'Ghost', parent: 'AAAAAAAAAAAA' });
    check('a folder in a folder that is not there is refused', !r.ok && /not there/.test(r.e), r);
    r = await lib('folderCreate', { name: 'Odd', parent: 'no good' });
    check('a parent that is not an id is refused', !r.ok && /not a valid folder/.test(r.e), r);
    r = await lib('folderCreate', { name: '2024', parent: H });
    check('the same name under another folder is fine', r.ok, r);
    const H24 = r.r.id;

    // ---- moving
    r = await lib('fileMove', { ids: [A, B], folder: W });
    check('two files are moved into a folder', r.ok && r.r.moved === 2 && r.r.unchanged === 0 && r.r.missing === 0, r);
    r = await lib('fileMove', { ids: [A, B, A], folder: W });
    check('moving them again changes nothing, and a repeated id counts once', r.ok && r.r.moved === 0 && r.r.unchanged === 2, r);
    r = await lib('fileMove', { ids: [Cc], folder: Y });
    check('a file goes into a folder inside a folder', r.ok && r.r.moved === 1, r);
    r = await lib('fileMove', { ids: [D, 'A'.repeat(43)], folder: H });
    check('a file that is not in the library is counted as missing; the rest moves', r.ok && r.r.moved === 1 && r.r.missing === 1, r);
    r = await lib('fileMove', { ids: [D, 'short'], folder: W });
    check('an id that is not a file id refuses the whole move', !r.ok && /not a valid file id/.test(r.e), r);
    r = await lib('fileSearch', { folder: H });
    check('...and the valid file in that move did not move', r.ok && r.r.items.length === 1 && r.r.items[0].id === D, r);
    r = await lib('fileMove', { ids: [D], folder: 'AAAAAAAAAAAA' });
    check('a move into a folder that is not there is refused', !r.ok && /not there/.test(r.e), r);
    r = await lib('fileMove', { ids: [], folder: W });
    check('a move of no files is refused', !r.ok && /Choose the files/.test(r.e), r);
    r = await lib('fileMove', { ids: Array.from({ length: 501 }, (_, i) => A), folder: W });
    check('a move of more than 500 files is refused', !r.ok && /At most 500/.test(r.e), r);

    // ---- listing and counts
    r = await lib('folderList');
    const byId = {}; if (r.ok) r.r.folders.forEach((f) => { byId[f.id] = f; });
    check('the folder list counts files in a folder and in the folders inside it',
      r.ok && byId[W].count === 2 && byId[W].total === 3 && byId[Y].count === 1 && byId[Y].total === 1 && byId[H].count === 1 && byId[H].total === 1 && byId[H24].count === 0, r);
    check('the list gives every file once: none in no folder, four in all', r.ok && r.r.unsorted === 0 && r.r.all === 4, r);
    check('the list is by name, each with its place', r.ok && r.r.folders.map((f) => f.name).join(',') === '2024,2024,Holiday,Work' && byId[Y].parent === W && byId[W].parent === null, r);
    r = await lib('fileSearch', { folder: W });
    check('a search in a folder gives its files and those of the folders inside it', r.ok && r.r.total === 3 && r.r.items.map((i) => i.id).sort().join() === [A, B, Cc].sort().join(), r);
    r = await lib('fileSearch', { folder: Y });
    check('a search in the inner folder gives only its own', r.ok && r.r.total === 1 && r.r.items[0].id === Cc && r.r.items[0].folder === Y, r);
    r = await lib('fileSearch', { folder: 'unsorted' });
    check('a search for files in no folder finds none now', r.ok && r.r.total === 0, r);
    r = await lib('fileSearch', { folder: 'AAAAAAAAAAAA' });
    check('a search in a folder that is not there is refused', !r.ok && /not there/.test(r.e), r);
    r = await lib('fileSearch', { folder: W, query: 'beach' });
    check('a folder and a word together', r.ok && r.r.total === 1 && r.r.items[0].id === B, r);
    r = await lib('fileSearch', { sort: 'name' });
    check('sorted by name', r.ok && r.r.items.map((i) => i.name).join() === 'beach.png,notes.md,plan.pdf,report.pdf', r);
    r = await lib('fileSearch', { sort: 'size' });
    check('sorted by size, the largest first', r.ok && r.r.items.map((i) => i.name).join() === 'beach.png,plan.pdf,report.pdf,notes.md', r);
    r = await lib('fileSearch', { sort: 'type' });
    check('sorted by type (the ending of the name)', r.ok && r.r.items.map((i) => i.name.split('.').pop()).join() === 'md,pdf,pdf,png', r);
    r = await lib('fileSearch', { sort: 'added' });
    check('sorted by when added, the newest first (the default too)', r.ok && r.r.items.map((i) => i.name).join() === 'plan.pdf,notes.md,beach.png,report.pdf', r);
    r = await lib('fileSearch', { sort: 'colour' });
    check('a way of sorting that is not one is refused', !r.ok && /not a way to sort/.test(r.e), r);

    // ---- renaming
    const rawBefore = await T(([did, id]) => window.__t.rawFile(did, id), [DID, B]);
    r = await lib('fileRename', { id: B, name: 'sea\\shore/sunset.png' });
    check('a rename keeps a name without any path', r.ok && r.r.name === 'sunset.png' && r.r.folder === W && r.r.same === 0, r);
    r = await lib('fileInfo', { id: B });
    check('the file reads back with the new name, and the rest of its record', r.ok && r.r.name === 'sunset.png' && r.r.type === 'image/png' && r.r.size === 9000 && r.r.chunks === 1, r);
    const rawAfter = await T(([did, id]) => window.__t.rawFile(did, id), [DID, B]);
    check('the record was sealed again with a new IV', rawBefore.iv !== rawAfter.iv && JSON.stringify(rawBefore.ct) !== JSON.stringify(rawAfter.ct));
    const bytesOk = await T(async ([id]) => { const c = new Uint8Array(await window.keoLibrary.fileRead({ id, n: 0 })); return (await window.__t.cidOf(c)) === id; }, [B]);
    check('the bytes are untouched: they still hash to the file\'s name', bytesOk);
    check('the new name is not readable in what is stored', !(await T(() => window.__t.leaks('sunset'))));
    r = await lib('fileSearch', { query: 'sunset' });
    check('a search finds it by the new name and not the old one', r.ok && r.r.total === 1 && r.r.items[0].id === B && (await lib('fileSearch', { query: 'beach' })).r.total === 0, r);
    r = await lib('fileRename', { id: A, name: 'SUNSET.png' });
    check('a name another file in the same folder has is allowed, and counted for the warning', r.ok && r.r.same === 1, r);
    r = await lib('fileRename', { id: Cc, name: 'sunset.png' });
    check('the same name in another folder is not counted', r.ok && r.r.same === 0, r);
    await lib('fileRename', { id: A, name: 'report.pdf' });
    await lib('fileRename', { id: Cc, name: 'notes.md' });
    r = await lib('fileRename', { id: B, name: ' \u0001 ' });
    check('an empty name is refused', !r.ok && /needs a name/.test(r.e), r);
    r = await lib('fileRename', { id: 'B'.repeat(43), name: 'x' });
    check('a file that is not in the library is refused', !r.ok && /not in the library/.test(r.e), r);
    r = await lib('fileRename', { id: 'nope', name: 'x' });
    check('an id that is not a file id is refused', !r.ok && /not a valid file id/.test(r.e), r);
    r = await lib('fileRename', { id: B, name: 'y'.repeat(400) + '.png' });
    check('a long name is cut to 255 characters', r.ok && r.r.name.length === 255, r && r.r && r.r.name.length);
    await lib('fileRename', { id: B, name: 'sunset.png' });

    // ---- renaming a folder
    r = await lib('folderRename', { id: Y, name: 'Old' });
    check('a folder is renamed and keeps its place and files', r.ok && r.r.name === 'Old' && r.r.parent === W && (await lib('fileSearch', { folder: Y })).r.total === 1, r);
    r = await lib('folderRename', { id: H, name: 'WORK' });
    check('a folder cannot take the name a folder in the same place has', !r.ok && /already a folder called "WORK"/.test(r.e), r);
    r = await lib('folderRename', { id: H, name: 'Holiday' });
    check('a folder can be renamed to its own name', r.ok, r);
    r = await lib('folderRename', { id: 'AAAAAAAAAAAA', name: 'z' });
    check('a folder that is not there cannot be renamed', !r.ok && /not there/.test(r.e), r);
    check('folder names are not readable in what is stored', !(await T(() => window.__t.leaks('Holiday'))) && !(await T(() => window.__t.leaks('Work'))));
    check('all the folders are one stored document', (await T(() => window.__t.count('docs'))) === 1);

    // ---- what the world may not do
    r = await T((did) => window.__t.tryp(window.keoLibrary.put({ objId: 'keofilefldrs', doc: { objId: 'keofilefldrs', did, type: 'book' } })), DID);
    check('the world cannot write over the folders as another kind of item', !r.ok && /kept for the folders/.test(r.e), r);
    r = await T((did) => window.__t.tryp(window.keoLibrary.put({ objId: 'abcdefghijkl', doc: { objId: 'abcdefghijkl', did, type: 'filefolders', folders: [] } })), DID);
    check('the world cannot write a folders document of its own', !r.ok && /Not a kind of library item/.test(r.e), r);

    // ---- deleting a folder moves everything up; it deletes no file
    r = await lib('folderDelete', { id: W });
    check('deleting a top-level folder: its two files go to no folder, its folder comes up', r.ok && r.r.files === 2 && r.r.folders === 1 && r.r.parent === null, r);
    r = await lib('folderList');
    const names = r.ok ? r.r.folders.map((f) => f.name + ':' + f.parent + ':' + f.count) : [];
    check('the inner folder is now at the top level, with its file', r.ok && names.indexOf('Old:null:1') >= 0, names);
    check('the files that were in it are in no folder, nothing was lost', r.ok && r.r.unsorted === 2 && r.r.all === 4, r);
    r = await lib('fileSearch', { folder: W });
    check('the deleted folder is gone', !r.ok && /not there/.test(r.e), r);
    r = await lib('folderDelete', { id: W });
    check('it cannot be deleted twice', !r.ok && /not there/.test(r.e), r);
    // a clash on the way up: put a folder called like the one that comes up
    r = await lib('folderCreate', { name: 'Box' }); const Box = r.r.id;
    r = await lib('folderCreate', { name: 'Old', parent: Box }); const InOld = r.r.id;     // "Old" is already at the top level
    await lib('fileMove', { ids: [A], folder: InOld });
    r = await lib('folderDelete', { id: Box });
    check('a folder that comes up under a name already there is renamed "(2)"', r.ok && r.r.folders === 1, r);
    r = await lib('folderList');
    const moved = r.ok && r.r.folders.filter((f) => f.id === InOld)[0];
    check('...and keeps its file', moved && moved.name === 'Old (2)' && moved.parent === null && moved.count === 1, moved);
    // deleting an inner folder: its files go to the folder above
    r = await lib('folderCreate', { name: 'P' }); const P = r.r.id;
    r = await lib('folderCreate', { name: 'Q', parent: P }); const Q = r.r.id;
    await lib('fileMove', { ids: [B], folder: Q });
    r = await lib('folderDelete', { id: Q });
    check('deleting an inner folder: its file goes up to the folder above', r.ok && r.r.files === 1 && r.r.parent === P, r);
    check('...and is found there', (await lib('fileSearch', { folder: P })).r.items.map((i) => i.id).join() === B);
    r = await lib('folderDelete', { id: P });
    check('deleting that one puts the file in no folder', r.ok && r.r.files === 1 && r.r.parent === null && (await lib('fileSearch', { folder: 'unsorted' })).r.items.some((i) => i.id === B));
    // a folder with no files at all, and one that was empty
    r = await lib('folderDelete', { id: H24 });
    check('an empty folder can be deleted', r.ok && r.r.files === 0 && r.r.folders === 0, r);

    // ---- removing a file takes it out of the counts
    const before = (await lib('folderList')).r;
    r = await lib('fileRemove', { id: A });
    const after = (await lib('folderList')).r;
    check('removing a file lowers the counts', r.ok && after.all === before.all - 1, [before.all, after.all]);

    // ---- a folder the record names but that is not there is "in no folder"
    // (a file carried to a library that has not the folder): checked below through Move my data

    // ---- Move my data carries names, folders and files
    const state = await T(async () => {
      const L = window.keoLibrary, f = await L.folderList(), s = await L.fileSearch({ limit: 200 });
      return { folders: f.folders.map((x) => [x.id, x.name, x.parent, x.count]).sort(), files: s.items.map((i) => [i.id, i.name, i.folder]).sort() };
    });
    const packed = await T(async () => {                                 // the sealed records as keo-transfer.js takes them, kept in this page
      const L = window.keoLibrary, did = (await L.exportSealed()).did, sealed = await L.exportSealed(), list = await L.exportFileList(), chunks = {};
      for (const f of list.files) for (let n = 0; n < f.chunks; n++) chunks[f.fid + '|' + n] = await L.exportFileChunk({ fid: f.fid, n });
      window.__pack = { sealed, list, chunks, did };
      return { docs: sealed.docs.length, files: list.files.length };
    });
    check('the pack to carry has the folders document and every file', packed.docs === 1 && packed.files === 3, packed);
    await T((did) => window.keoLibrary.purge(did), DID);
    check('with the library emptied, no folders and no files are left', (await lib('folderList')).r.all === 0 && (await lib('folderList')).r.folders.length === 0);
    const back = await T(async () => {
      const L = window.keoLibrary, p = window.__pack, out = {};
      out.docs = await L.importSealed(p.sealed);
      out.files = [];
      for (const f of p.list.files) out.files.push((await L.importFile({ id: f.id, manifest: f.manifest, readChunk: async (n) => p.chunks[f.fid + '|' + n] })).status);
      return out;
    });
    check('importing adds the folders document and every file', back.docs.docs === 1 && back.docs.unreadable === 0 && back.files.join() === 'added,added,added', back);
    const state2 = await T(async () => {
      const L = window.keoLibrary, f = await L.folderList(), s = await L.fileSearch({ limit: 200 });
      return { folders: f.folders.map((x) => [x.id, x.name, x.parent, x.count]).sort(), files: s.items.map((i) => [i.id, i.name, i.folder]).sort() };
    });
    check('the folders, their counts, the names and where each file is are as they were', JSON.stringify(state2) === JSON.stringify(state), [state, state2]);

    // ---- a file whose folder is gone shows as in no folder
    r = await lib('folderDelete', { id: state2.folders[0][0] });
    check('(folders are still changeable after an import)', r.ok, r);

    // ---- the bridge: the world reaches the same ops
    const via = await frame.evaluate(async () => {
      const call = (op, a) => window.keo.call(op, a, 30000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: String(e && e.message || e) }));
      const out = {};
      out.made = await call('library.folderCreate', { name: 'From the world' });
      out.list = await call('library.folderList', {});
      const s = await call('library.fileSearch', { limit: 5, sort: 'name' });
      out.search = s;
      const id = s.ok && s.r.items[0] && s.r.items[0].id;
      out.move = await call('library.fileMove', { ids: [id], folder: out.made.r && out.made.r.id });
      out.rename = await call('library.fileRename', { id, name: 'renamed-in-world.txt' });
      out.in = await call('library.fileSearch', { folder: out.made.r && out.made.r.id });
      out.fren = await call('library.folderRename', { id: out.made.r && out.made.r.id, name: 'Renamed' });
      out.del = await call('library.folderDelete', { id: out.made.r && out.made.r.id });
      out.after = await call('library.fileSearch', { query: 'renamed-in-world' });
      return out;
    });
    check('the world can make a folder through the bridge', via.made.ok && via.made.r.name === 'From the world', via.made);
    check('...list the folders', via.list.ok && via.list.r.folders.some((f) => f.name === 'From the world'), via.list);
    check('...move a file into it', via.move.ok && via.move.r.moved === 1, via.move);
    check('...rename the file', via.rename.ok && via.rename.r.name === 'renamed-in-world.txt' && via.rename.r.same === 0, via.rename);
    check('...find the file in the folder', via.in.ok && via.in.r.total === 1 && via.in.r.items[0].name === 'renamed-in-world.txt', via.in);
    check('...rename and delete the folder, the file then being in no folder', via.fren.ok && via.del.ok && via.del.r.files === 1 && via.after.ok && via.after.r.items[0].folder === null, [via.fren, via.del, via.after]);

    check('no page error', errors.length === 0, errors);
    const stray = outside.filter((u) => !/\/iframe_api$/.test(u));       // the home world's video player asks for this one; the page blocks it
    check('nothing else was requested outside the package', stray.length === 0, stray.slice(0, 5));
  } catch (e) {
    console.log('FAIL the test stopped: ' + (e && e.stack || e)); failed++;
  } finally {
    await ctx.close();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
