// The library's database moves from version 3 to 4 (the small pictures store is new). A person's library made before that must come through
// with every record where it was, and the new store must be there and work. A version-3 database is made by hand in the shell page, as the
// previous release made it (docs, blobs, blobtotal, files, chunks, pending, each with its indexes), holding one record in each of
// docs, blobs, files and chunks; then the library is used. Nothing here signs in: the records are only checked to be still there.
// Usage: node keo-dbupgrade-test.js <repo root> <extension folder> <work dir>
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 900) : '')); if (!ok) failed++; }

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-dbup-' + Date.now()), {
    headless: false, viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    await page.goto(`chrome-extension://${ID}/start.html`);
    await sleep(2500);
    // the database as version 3 made it
    const made = await page.evaluate(() => new Promise((res) => {
      const del = indexedDB.deleteDatabase('keo-library');
      const make = () => {
        const q = indexedDB.open('keo-library', 3);
        q.onupgradeneeded = () => {
          const db = q.result;
          db.createObjectStore('docs', { keyPath: 'id' }).createIndex('did', 'did');
          db.createObjectStore('blobs', { keyPath: 'id' }).createIndex('did', 'did');
          db.createObjectStore('blobtotal', { keyPath: 'did' });
          db.createObjectStore('files', { keyPath: 'id' }).createIndex('did', 'did');
          const c = db.createObjectStore('chunks', { keyPath: 'id' }); c.createIndex('did', 'did'); c.createIndex('fk', 'fk');
          db.createObjectStore('pending', { keyPath: 'id' }).createIndex('did', 'did');
        };
        q.onsuccess = () => {
          const db = q.result, t = db.transaction(['docs', 'blobs', 'files', 'chunks', 'blobtotal'], 'readwrite');
          t.objectStore('docs').put({ id: 'did:old|doc1', did: 'did:old', iv: 'aa', ct: new Uint8Array([1, 2, 3]) });
          t.objectStore('blobs').put({ id: 'did:old|blob1', did: 'did:old', iv: 'bb', ct: new Uint8Array([4, 5]) });
          t.objectStore('files').put({ id: 'did:old|file1', did: 'did:old', iv: 'cc', ct: new Uint8Array([6]) });
          t.objectStore('chunks').put({ id: 'did:old|f|0', did: 'did:old', fk: 'did:old|f', iv: 'dd', ct: new Uint8Array([7, 8]) });
          t.objectStore('blobtotal').put({ did: 'did:old', total: 123 });
          t.oncomplete = () => { const v = db.version; db.close(); res({ version: v }); };
          t.onerror = () => res({ err: String(t.error) });
        };
        q.onerror = () => res({ err: String(q.error) });
      };
      del.onsuccess = make; del.onerror = () => res({ err: 'delete failed' });
      del.onblocked = () => res({ err: 'delete blocked: the shell page holds the database open' });
    }));
    check('setup: a version-3 database with one record in docs, blobs, files and chunks', made.version === 3, made);
    // using the library opens it at the new version (purge of ANOTHER identity needs no session and opens every store)
    const used = await page.evaluate(() => window.keoLibrary.purge('did:someone-else').then(() => ({ ok: true }), (e) => ({ ok: false, e: String(e.message || e) })));
    check('the library opens it and works', used.ok, used);
    const after = await page.evaluate(() => new Promise((res) => {
      const q = indexedDB.open('keo-library');
      q.onsuccess = () => {
        const db = q.result, names = Array.from(db.objectStoreNames), out = { version: db.version, names };
        const t = db.transaction(['docs', 'blobs', 'files', 'chunks', 'blobtotal', 'thumbs']);
        const reads = { docs: t.objectStore('docs').get('did:old|doc1'), blobs: t.objectStore('blobs').get('did:old|blob1'), files: t.objectStore('files').get('did:old|file1'),
          chunks: t.objectStore('chunks').get('did:old|f|0'), total: t.objectStore('blobtotal').get('did:old') };
        out.thumbIndex = Array.from(t.objectStore('thumbs').indexNames);
        t.oncomplete = () => { out.recs = { docs: Array.from(reads.docs.result.ct), blobs: Array.from(reads.blobs.result.ct), files: Array.from(reads.files.result.ct), chunks: Array.from(reads.chunks.result.ct), total: reads.total.result.total }; db.close(); res(out); };
        t.onerror = () => res({ err: String(t.error) });
      };
      q.onerror = () => res({ err: String(q.error) });
    }));
    check('the database is now version 4 and has the new store with its index', after.version === 4 && after.names.includes('thumbs') && after.thumbIndex.join() === 'did', after);
    check('every record of the old database is still there, byte for byte', !!after.recs && after.recs.docs.join() === '1,2,3' && after.recs.blobs.join() === '4,5' && after.recs.files.join() === '6' && after.recs.chunks.join() === '7,8' && after.recs.total === 123, after.recs);
    check('no page errors', errors.length === 0, errors);
  } catch (e) {
    check('the run finished without an exception', false, String(e && e.stack || e));
  }
  await ctx.close();
  console.log(failed ? 'FAILED: ' + failed : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
