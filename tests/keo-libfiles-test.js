// Files in the library that are sent in chunks (shell/keo-library.js: fileBegin, fileChunk, fileEnd, fileAbort, fileInfo, fileRead,
// fileRemove, and the bridge ops of the same names): what comes back is what went in, the shell names the file by the hash of its
// bytes, what is refused (out of order, wrong size, an unknown upload, a full library, too many at once), what is on disk (sealed,
// bound to its place: a chunk moved, swapped or changed is not handed back), a file left unfinished is swept, a file of the older
// single-record kind still reads, removal gives the space back, and a 100 MB file goes through the real bridge from the world.
// Usage: node keo-libfiles-test.js <repo root> <extension folder> <work dir>
// A headed browser with the extension loaded, `localhost` unresolvable, a virtual authenticator with PRF (so nothing here says anything
// about a real one). Large buffers are made and compared inside the pages, so they never cross the test's own channel.
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

// helpers that live in the shell page, so big buffers stay there
const SETUP = () => {
  const L = window.keoLibrary, enc = new TextEncoder();
  const t = window.__t = {};
  t.fill = (n, seed) => { const u = new Uint8Array(n); let x = (seed >>> 0) || 1; for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; u[i] = x & 255; } return u; };
  t.b64u = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).split('+').join('-').split('/').join('_').split('=').join(''); };
  t.cid = async (u8) => t.b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', u8)));
  t.tryp = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message }));
  t.data = {};                                         // named buffers, so a later call can use them
  t.make = (name, n, seed) => { t.data[name] = t.fill(n, seed); return n; };
  t.send = async (name, fname, type) => {              // the whole sequence, with the real chunk size
    const u8 = t.data[name], b = await L.fileBegin({ name: fname, type, size: u8.length }), C = b.chunkBytes; let n = 0;
    for (let o = 0; o < u8.length; o += C) await L.fileChunk({ upload: b.upload, n: n++, bytes: u8.slice(o, Math.min(o + C, u8.length)) });
    return { upload: b.upload, end: await L.fileEnd({ upload: b.upload }) };
  };
  t.readBack = async (id) => {                         // every chunk, compared with the source buffer; returns the first difference
    const info = await L.fileInfo({ id }); let off = 0;
    for (let n = 0; n < info.chunks; n++) {
      const c = new Uint8Array(await L.fileRead({ id, n })); const src = t.data[t.cur];
      for (let i = 0; i < c.length; i++) if (c[i] !== src[off + i]) return { n, i };
      off += c.length;
    }
    return off === t.data[t.cur].length ? null : { short: off };
  };
  t.idb = (stores, mode, fn) => new Promise((res, rej) => { const q = indexedDB.open('keo-library'); q.onerror = () => rej(q.error); q.onsuccess = () => { const db = q.result, tx = db.transaction(stores, mode); let out; try { out = fn(tx); } catch (e) { db.close(); return rej(e); } tx.oncomplete = () => { db.close(); res(typeof out === 'function' ? out() : out); }; tx.onerror = tx.onabort = () => { db.close(); rej(tx.error); }; }; });
  t.count = (store) => t.idb([store], 'readonly', (tx) => { const r = tx.objectStore(store).count(); return () => r.result; });
  t.keys = (store) => t.idb([store], 'readonly', (tx) => { const r = tx.objectStore(store).getAllKeys(); return () => r.result; });
  t.total = () => t.idb(['blobtotal'], 'readonly', (tx) => { const r = tx.objectStore('blobtotal').getAll(); return () => (r.result[0] ? r.result[0].total : 0); });
  // does any stored ciphertext contain the marker text (a sealed record must not)
  t.leaks = (marker) => t.idb(['files', 'chunks', 'pending'], 'readonly', (tx) => { const m = enc.encode(marker), rs = ['files', 'chunks'].map((s) => tx.objectStore(s).getAll()); return () => rs.some((r) => r.result.some((x) => { const a = JSON.stringify(Array.from(x.ct.subarray(0, 4096))); return a.includes(JSON.stringify(Array.from(m)).slice(1, -1)); })); });
  t.rawFiles = () => t.idb(['files'], 'readonly', (tx) => { const r = tx.objectStore('files').getAll(); return () => r.result.map((x) => ({ id: x.id, fields: Object.keys(x).sort().join(',') })); });
  t.swapChunks = (fk, a, b) => t.idb(['chunks'], 'readwrite', (tx) => { const st = tx.objectStore('chunks'), ra = st.get(fk + '|' + a), rb = st.get(fk + '|' + b); ra.onsuccess = () => { rb.onsuccess = () => { const x = ra.result, y = rb.result, ct = x.ct, iv = x.iv; x.ct = y.ct; x.iv = y.iv; y.ct = ct; y.iv = iv; st.put(x); st.put(y); }; }; });
  t.copyChunk = (fromKey, toKey) => t.idb(['chunks'], 'readwrite', (tx) => { const st = tx.objectStore('chunks'), r = st.get(fromKey); r.onsuccess = () => { const x = Object.assign({}, r.result); x.id = toKey; st.put(x); }; });
  t.flip = (store, key, at) => t.idb([store], 'readwrite', (tx) => { const st = tx.objectStore(store), r = st.get(key); r.onsuccess = () => { const x = r.result; x.ct[at] ^= 1; st.put(x); }; });
  t.del = (store, key) => t.idb([store], 'readwrite', (tx) => { tx.objectStore(store).delete(key); });
  t.chunkKeys = async (did) => (await t.keys('chunks')).filter((k) => String(k).startsWith(did + '|'));
  t.pendingAge = (ms) => t.idb(['pending'], 'readwrite', (tx) => { const st = tx.objectStore('pending'), r = st.getAll(); r.onsuccess = () => r.result.forEach((x) => { x.at = Date.now() - ms; st.put(x); }); });
  return true;
};

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-libfiles'), {
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

    // ---- nobody signed in
    let r = await T(() => window.__t.tryp(window.keoLibrary.fileBegin({ name: 'a', type: 'text/plain', size: 5 })));
    check('with nobody signed in a file cannot be announced', !r.ok && /Sign in/.test(r.e), r);

    const made = await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }));
    const DID = made.did;
    await frame.evaluate(() => window.keo.call('world.go', { kind: 'enter' }, 60000)).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    const C = await T(() => window.keoLibrary.CHUNK_BYTES);
    check('setup: the chunk size is 4 MiB', C === 4 * 1024 * 1024, C);

    // ---- a three-chunk file, in and out
    const SIZE = 2 * C + 12345;
    await T(([n]) => window.__t.make('f1', n, 11), [SIZE]);
    const want = await T(() => window.__t.cid(window.__t.data.f1));
    const sent = await T(() => window.__t.tryp(window.__t.send('f1', 'D:\\docs\\pics/holiday.png', 'IMAGE/PNG')));
    check('a file sent in three chunks is accepted', sent.ok && sent.r.end && sent.r.end.size === SIZE && sent.r.end.existed === false, sent);
    check('the shell names it by the hash of its bytes (the world is not asked)', sent.ok && sent.r.end.id === want, [sent.ok && sent.r.end.id, want]);
    const id1 = want;
    const info = await T((id) => window.keoLibrary.fileInfo({ id }), id1);
    check('info: a name without any path, the type in lower case, the size, three chunks, not the old kind',
      info && info.name === 'holiday.png' && info.type === 'image/png' && info.size === SIZE && info.chunks === 3 && info.chunkBytes === C && info.legacy === false, info);
    const diff = await T((id) => { window.__t.cur = 'f1'; return window.__t.readBack(id); }, id1);
    check('every chunk reads back exactly as it went in', diff === null, diff);
    check('the last chunk has the length that is left', (await T((id) => window.keoLibrary.fileRead({ id, n: 2 }).then((b) => b.byteLength), id1)) === 12345);
    check('the total grew by the size of the file', (await T(() => window.__t.total())) === SIZE);

    // ---- the same bytes again
    const chunksBefore = await T(() => window.__t.count('chunks'));
    const again = await T(() => window.__t.tryp(window.__t.send('f1', 'copy.png', 'image/png')));
    check('the same bytes sent again are kept once', again.ok && again.r.end.existed === true && again.r.end.id === id1, again);
    check('and leave no second set of chunks and no change in the total', (await T(() => window.__t.count('chunks'))) === chunksBefore && (await T(() => window.__t.total())) === SIZE);
    check('the first name is the one kept', (await T((id) => window.keoLibrary.fileInfo({ id }).then((i) => i.name), id1)) === 'holiday.png');
    await T(() => window.__t.make('f1b', 5000, 12));
    const other = await T(() => window.__t.tryp(window.__t.send('f1b', 'other.bin', 'application/octet-stream')));
    check('other bytes get another name', other.ok && other.r.end.id !== id1);
    const idB = other.r.end.id;

    // ---- what is refused
    const begin = (size, extra) => T(([s, x]) => window.__t.tryp(window.keoLibrary.fileBegin(Object.assign({ name: 'x', type: 'text/plain', size: s }, x || {}))), [size, extra]);
    const chunk = (up, n, len) => T(([u, nn, l]) => window.__t.tryp(window.keoLibrary.fileChunk({ upload: u, n: nn, bytes: new Uint8Array(l).fill(7) })), [up, n, len]);
    r = await begin(-1); check('a negative size is refused', !r.ok && /size/.test(r.e), r);
    r = await begin(1.5); check('a size that is not a whole number is refused', !r.ok && /size/.test(r.e), r);
    r = await begin('10'); check('a size that is text is refused', !r.ok && /size/.test(r.e), r);
    r = await begin(2 * 1024 * 1024 * 1024); check('a file bigger than the library may hold is refused when announced', !r.ok && /library is full/.test(r.e), r);
    let up = (await begin(C + 10)).r.upload;
    r = await chunk(up, 1, C); check('a chunk out of order is refused', !r.ok && /in order/.test(r.e), r);
    r = await chunk(up, 0, 100); check('a short chunk that is not the last is refused', !r.ok && /last chunk/.test(r.e), r);
    r = await chunk(up, 0, C + 11); check('a chunk longer than the file is refused', !r.ok && /does not fit/.test(r.e), r);
    r = await chunk(up, 0, 0); check('an empty chunk is refused', !r.ok && /does not fit/.test(r.e), r);
    r = await T((u) => window.__t.tryp(window.keoLibrary.fileChunk({ upload: u, n: 0, bytes: 'text' })), up); check('a chunk that is not bytes is refused', !r.ok && /must be bytes/.test(r.e), r);
    r = await chunk(up, 0, C); check('a good first chunk is accepted', r.ok && r.r.received === C, r);
    r = await chunk(up, 0, C); check('the same chunk twice is refused', !r.ok && /in order/.test(r.e), r);
    r = await T((u) => window.__t.tryp(window.keoLibrary.fileEnd({ upload: u })), up); check('finishing before all of it has arrived is refused', !r.ok && /not complete/.test(r.e), r);
    const keysBeforeAbort = (await T((d) => window.__t.chunkKeys(d), DID)).length;
    r = await T((u) => window.__t.tryp(window.keoLibrary.fileAbort({ upload: u })), up); check('an upload can be given up', r.ok && r.r === true, r);
    check('giving up removes what it stored', (await T((d) => window.__t.chunkKeys(d), DID)).length === keysBeforeAbort - 1);
    r = await chunk(up, 1, 10); check('a given-up upload is no longer open', !r.ok && /not open/.test(r.e), r);
    r = await T(() => window.__t.tryp(window.keoLibrary.fileEnd({ upload: 'nothing' }))); check('an upload that never existed is refused', !r.ok && /not open/.test(r.e), r);
    r = await T(() => window.__t.tryp(window.keoLibrary.fileAbort({ upload: 'nothing' }))); check('giving up an upload that never existed is harmless', r.ok && r.r === true, r);
    const u1 = (await begin(10)).r.upload, u2 = (await begin(10)).r.upload;
    r = await begin(10); check('a third upload at once is refused', !r.ok && /Too many/.test(r.e), r);
    await T(([a, b]) => Promise.all([window.keoLibrary.fileAbort({ upload: a }), window.keoLibrary.fileAbort({ upload: b })]), [u1, u2]);
    r = await begin(10); check('and one can start again when the others are done', r.ok); await T((u) => window.keoLibrary.fileAbort({ upload: u }), r.r.upload);
    r = await T(() => window.__t.tryp(window.keoLibrary.fileInfo({ id: 'short' }))); check('a file id that is not a hash is refused', !r.ok && /valid file id/.test(r.e), r);
    r = await T(() => window.__t.tryp(window.keoLibrary.fileRead({ id: 'A'.repeat(43), n: 0 }))); check('a file that is not there reads as nothing', r.ok && r.r === null, r);
    r = await T((id) => window.__t.tryp(window.keoLibrary.fileRead({ id, n: 3 })), id1); check('a chunk number past the end is refused', !r.ok && /no chunk/.test(r.e), r);
    r = await T((id) => window.__t.tryp(window.keoLibrary.fileRead({ id, n: -1 })), id1); check('a negative chunk number is refused', !r.ok, r);
    r = await T((id) => window.__t.tryp(window.keoLibrary.fileRead({ id, n: 0.5 })), id1); check('a chunk number that is not whole is refused', !r.ok, r);

    // an empty file, and a file of exactly one chunk
    await T(() => window.__t.make('e0', 0, 1));
    const e0 = await T(() => window.__t.tryp(window.__t.send('e0', 'empty.txt', 'text/plain')));
    check('an empty file is accepted and has no chunks', e0.ok && e0.r.end.size === 0 && (await T((id) => window.keoLibrary.fileInfo({ id }).then((i) => i.chunks), e0.r.end.id)) === 0, e0);
    await T(([n]) => window.__t.make('e1', n, 21), [C]);
    const e1 = await T(() => window.__t.tryp(window.__t.send('e1', 'exact.bin', '')));
    check('a file of exactly one chunk is one chunk, and a missing type becomes the generic one', e1.ok && (await T((id) => window.keoLibrary.fileInfo({ id }), e1.r.end.id)).chunks === 1 && (await T((id) => window.keoLibrary.fileInfo({ id }), e1.r.end.id)).type === 'application/octet-stream', e1);
    check('it reads back exactly', (await T((id) => { window.__t.cur = 'e1'; return window.__t.readBack(id); }, e1.r.end.id)) === null);

    // ---- what is on disk
    await T(() => { const m = 'KEO-LIBFILES-MARKER-KEO-LIBFILES-MARKER'; const u = window.__t.fill(3 * 1024 * 1024, 5); for (let i = 0; i + m.length < u.length; i += 1024) for (let j = 0; j < m.length; j++) u[i + j] = m.charCodeAt(j); window.__t.data.mk = u; });
    const mk = await T(() => window.__t.tryp(window.__t.send('mk', 'KEO-LIBFILES-MARKER-name.txt', 'text/plain')));
    check('(setup) a file full of a known text is stored', mk.ok, mk);
    check('no stored chunk or manifest holds that text (it is sealed)', (await T(() => window.__t.leaks('KEO-LIBFILES-MARKER'))) === false);
    const rf = await T(() => window.__t.rawFiles());
    check('a manifest is only an id, an identity, an iv and sealed bytes: no name, type or size in the clear', rf.length >= 3 && rf.every((x) => x.fields === 'ct,did,id,iv'), rf);
    await T((id) => window.keoLibrary.fileRemove({ id }), mk.r.end.id);

    // ---- a record that was moved, swapped or changed is not handed back
    const setsOf = async () => { const m = {}; (await T((d) => window.__t.chunkKeys(d), DID)).forEach((k) => { const p = k.split('|'); (m[p[0] + '|' + p[1]] = m[p[0] + '|' + p[1]] || []).push(p[2]); }); return m; };
    const sets = await setsOf();
    const f1Set = Object.keys(sets).find((k) => sets[k].length === 3);
    check('(setup) the three-chunk file has its own set of chunks', !!f1Set, sets);
    await T(([fk]) => window.__t.swapChunks(fk, 0, 1), [f1Set]);
    r = await T((id) => window.__t.tryp(window.keoLibrary.fileRead({ id, n: 0 })), id1); check('two chunks swapped on disk: the first is refused', !r.ok && /could not be decrypted/.test(r.e), r);
    r = await T((id) => window.__t.tryp(window.keoLibrary.fileRead({ id, n: 1 })), id1); check('and the second', !r.ok && /could not be decrypted/.test(r.e), r);
    r = await T((id) => window.__t.tryp(window.keoLibrary.fileRead({ id, n: 2 }).then((b) => b.byteLength)), id1); check('the chunk that was not touched still reads', r.ok && r.r === 12345, r);
    await T(([fk]) => window.__t.swapChunks(fk, 0, 1), [f1Set]);
    check('swapped back, the file reads again', (await T((id) => { window.__t.cur = 'f1'; return window.__t.readBack(id); }, id1)) === null);
    // a chunk of this file put in the slot of every other one-chunk file (a record moved to another file)
    const singles = Object.keys(sets).filter((k) => sets[k].length === 1);
    for (const k of singles) await T(([from, to]) => window.__t.copyChunk(from + '|0', to + '|0'), [f1Set, k]);
    check('(setup) there are other one-chunk files to put it in', singles.length >= 2, singles);
    r = await T((id) => window.__t.tryp(window.keoLibrary.fileRead({ id, n: 0 })), idB); check('a chunk moved into another file is refused', !r.ok && /could not be decrypted/.test(r.e), r);
    r = await T((id) => window.__t.tryp(window.keoLibrary.fileRead({ id, n: 0 })), e1.r.end.id); check('and in the other', !r.ok && /could not be decrypted/.test(r.e), r);
    await T(([fk]) => window.__t.flip('chunks', fk + '|1', 100), [f1Set]);
    r = await T((id) => window.__t.tryp(window.keoLibrary.fileRead({ id, n: 1 })), id1); check('one changed bit in a chunk: refused', !r.ok && /could not be decrypted/.test(r.e), r);
    await T(([fk]) => window.__t.flip('chunks', fk + '|1', 100), [f1Set]);
    check('changed back, the chunk reads again', (await T((id) => { window.__t.cur = 'f1'; return window.__t.readBack(id); }, id1)) === null);
    const manKey = (await T(() => window.__t.keys('files'))).find((k) => k.endsWith('|' + id1));
    await T(([k]) => window.__t.flip('files', k, 20), [manKey]);
    r = await T((id) => window.__t.tryp(window.keoLibrary.fileInfo({ id })), id1); check('one changed bit in the manifest: refused', !r.ok && /could not be decrypted/.test(r.e), r);
    await T(([k]) => window.__t.flip('files', k, 20), [manKey]);
    check('changed back, the manifest opens again', (await T((id) => window.keoLibrary.fileInfo({ id }).then((i) => i && i.name), id1)) === 'holiday.png');
    await T(([fk]) => window.__t.del('chunks', fk + '|1'), [f1Set]);
    r = await T((id) => window.__t.tryp(window.keoLibrary.fileRead({ id, n: 1 })), id1); check('a chunk that is missing is reported as damage', !r.ok && /missing/.test(r.e), r);
    await T((id) => window.keoLibrary.fileRemove({ id }), idB);
    await T((id) => window.keoLibrary.fileRemove({ id }), e1.r.end.id);

    // ---- the older kind of file (one record) is still there, and reads as one chunk
    const legacyCid = await T(async () => { const u = window.__t.fill(70000, 77); const c = await window.__t.cid(u); await window.keoLibrary.putBlob({ cid: c, bytes: u.buffer }); window.__t.data.leg = u; return c; });
    const li = await T((id) => window.keoLibrary.fileInfo({ id }), legacyCid);
    check('an older single-record file shows as one chunk with no name', li && li.legacy === true && li.size === 70000 && li.chunks === 1 && li.name === '', li);
    check('and reads back through the new call', (await T((id) => { window.__t.cur = 'leg'; return window.__t.readBack(id); }, legacyCid)) === null);
    r = await T((id) => window.__t.tryp(window.keoLibrary.fileRead({ id, n: 1 })), legacyCid); check('it has no second chunk', !r.ok && /no chunk/.test(r.e), r);
    const sameLegacy = await T(() => window.__t.tryp(window.__t.send('leg', 'again.bin', 'application/octet-stream')));
    check('the same bytes sent as a file of the new kind are known already', sameLegacy.ok && sameLegacy.r.end.existed === true && sameLegacy.r.end.id === legacyCid, sameLegacy);

    // ---- removal gives the space back
    const totalBefore = await T(() => window.__t.total());
    r = await T((id) => window.keoLibrary.fileRemove({ id }), id1); check('a file is removed', r === true);
    check('the total went down by its size', (await T(() => window.__t.total())) === totalBefore - SIZE);
    check('its chunks are gone', (await T((d) => window.__t.chunkKeys(d), DID)).filter((k) => k.startsWith(f1Set + '|')).length === 0);
    check('it is no longer there', (await T((id) => window.keoLibrary.fileInfo({ id }), id1)) === null);
    check('removing it again says it was not there', (await T((id) => window.keoLibrary.fileRemove({ id }), id1)) === false);
    check('an older single-record file is removed by the same call', (await T((id) => window.keoLibrary.fileRemove({ id }), legacyCid)) === true && (await T((id) => window.keoLibrary.fileInfo({ id }), legacyCid)) === null);

    // ---- an upload left unfinished is swept at the next upload, once it has been quiet long enough
    const lone = (await begin(C + 5)).r.upload; await chunk(lone, 0, C);
    await T(() => window.keoLibrary.reset());                    // what the end of a session does: the upload is forgotten
    const pendBefore = await T(() => window.__t.count('pending')), chunkBefore = (await T((d) => window.__t.chunkKeys(d), DID)).length;
    const fresh = await begin(5); await T((u) => window.keoLibrary.fileAbort({ upload: u }), fresh.r.upload);
    check('a recent unfinished upload is NOT swept (another tab may be using it)', (await T((d) => window.__t.chunkKeys(d), DID)).length === chunkBefore && pendBefore >= 1);
    await T(() => window.__t.pendingAge(10 * 60 * 1000));
    const fresh2 = await begin(5); await T((u) => window.keoLibrary.fileAbort({ upload: u }), fresh2.r.upload);
    check('one that has been quiet for ten minutes is swept, with its chunk', (await T((d) => window.__t.chunkKeys(d), DID)).length === chunkBefore - 1 && (await T(() => window.__t.count('pending'))) === 0);

    // ---- the real bridge, from the world, with 100 MB
    const BIG = 100 * 1024 * 1024;
    await T(([n]) => { const t = window.__t; t.data = {}; t.make('big', n, 31); return true; }, [BIG]);
    const wantBig = await T(() => window.__t.cid(window.__t.data.big));
    const bigBytesHex = await T(() => { const u = window.__t.data.big; const out = []; for (let i = 0; i < 40; i++) out.push(u[i * 99991 % u.length]); return out; });
    // the world builds the same bytes itself (it has no access to the shell's), sends them through the bridge, reads them back and compares
    const viaWorld = await frame.evaluate(async ([n, seed]) => {
      const fill = (len, sd) => { const u = new Uint8Array(len); let x = (sd >>> 0) || 1; for (let i = 0; i < len; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; u[i] = x & 255; } return u; };
      const data = fill(n, seed), call = (op, a) => window.keo.call(op, a, 120000), out = {};
      let t0 = performance.now();
      const b = await call('library.fileBegin', { name: 'big.bin', type: 'application/octet-stream', size: data.length });
      for (let o = 0, k = 0; o < data.length; o += b.chunkBytes, k++) await call('library.fileChunk', { upload: b.upload, n: k, bytes: data.slice(o, Math.min(o + b.chunkBytes, data.length)) });
      const end = await call('library.fileEnd', { upload: b.upload }); out.putMs = Math.round(performance.now() - t0); out.id = end.id; out.size = end.size;
      t0 = performance.now();
      const info = await call('library.fileInfo', { id: end.id }), parts = [];
      for (let k = 0; k < info.chunks; k++) parts.push(await call('library.fileRead', { id: end.id, n: k }));
      out.getMs = Math.round(performance.now() - t0); out.chunks = info.chunks;
      const back = new Uint8Array(await new Blob(parts).arrayBuffer());
      out.equal = back.length === data.length && back.every((v, i) => v === data[i]);
      out.removed = await call('library.fileRemove', { id: end.id });
      return out;
    }, [BIG, 31]);
    console.log('     (100 MB through the bridge from the world: ' + viaWorld.chunks + ' chunks, in ' + viaWorld.putMs + ' ms, out ' + viaWorld.getMs + ' ms)');
    check('100 MB goes in through the bridge from the world, in 25 chunks', viaWorld.size === BIG && viaWorld.chunks === 25, viaWorld);
    check('its name is the hash of its bytes (the platform digest of the same bytes)', viaWorld.id === wantBig, [viaWorld.id, wantBig]);
    check('and it comes back through the bridge exactly as it went in', viaWorld.equal === true, viaWorld);
    check('the bridge removes it, and the total is back where it was', viaWorld.removed === true && (await T(() => window.__t.total())) === totalBefore - SIZE - 70000);

    // ---- removing the identity removes its files
    await T(([n]) => window.__t.make('g', n, 41), [C + 7]);
    await T(() => window.__t.send('g', 'g.bin', 'text/plain'));
    const up3 = (await begin(C + 5)).r.upload; await chunk(up3, 0, C);
    check('(setup) there are files, chunks and an unfinished upload', (await T(() => window.__t.count('files'))) >= 1 && (await T(() => window.__t.count('chunks'))) >= 2 && (await T(() => window.__t.count('pending'))) >= 1);
    await T((d) => window.keoLibrary.purge(d), DID);
    check('purging the identity empties the file stores, the chunks, the unfinished uploads and the total',
      (await T(() => window.__t.count('files'))) === 0 && (await T(() => window.__t.count('chunks'))) === 0 && (await T(() => window.__t.count('pending'))) === 0 && (await T(() => window.__t.total())) === 0);

    check('no page errors', errors.length === 0, errors);
    // the home world asks for a video player script that its own policy refuses: not ours, and every suite that opens it ignores it
    const stray = outside.filter((u) => !/\/iframe_api$/.test(u));
    check('nothing else was requested outside the package', stray.length === 0, stray.slice(0, 5));
  } finally { await ctx.close(); }
  console.log(failed ? failed + ' FAILED' : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(1); });
