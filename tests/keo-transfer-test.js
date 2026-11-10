// Moving the data of an identity to another webputer (shell/keo-transfer.js): TWO browsers that are two origins, the same identity
// linked to both (by the shell calls the link dialog uses), saved worlds and a library made on the first, then the dialog used by REAL
// clicks, a real download on one side and the browser's real file chooser on the other. The world can only ask for the dialog.
// Usage: node keo-transfer-test.js <repo root> <package folder> <work dir>
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const { idOfPackage, buildSecond, launch: launchIn } = require('./two-origins.js');
const launch = (dir, profile) => launchIn(chromium, dir, profile, WORK);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 700) : '')); }
async function poll(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(150); } return null; }
async function waitForWorld(page) {
  let frame = null;
  for (let i = 0; i < 100 && !frame; i++) { frame = page.frames().find((f) => /world\.html$/.test(f.url())); if (!frame) await sleep(200); }
  for (let i = 0; i < 150; i++) { try { if (await frame.evaluate(() => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init))) break; } catch (e) {} await sleep(300); }
  await sleep(1000);
  return frame;
}
const op = (frame, name, args) => frame.evaluate(([o, a]) => window.keo.call(o, a || {}, 60000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [name, args]);
const call = (page, fn, arg) => page.evaluate(async ([src, a]) => {
  try { return { ok: true, r: await (new Function('return (' + src + ')')())(a) }; } catch (e) { return { ok: false, err: (e && e.name) + ': ' + (e && e.message) }; }
}, [fn.toString(), arg]);
const SAVE = '#keo-transfer button[data-act=save]', ADD = '#keo-transfer button[data-act=add]', CLOSE = '#keo-transfer button[data-act=close]';
const dlg = (P) => P.page.evaluate(() => { const r = document.getElementById('keo-transfer'); if (!r) return null; return { hidden: r.hidden, result: r.querySelector('.result').textContent, hint: r.querySelector('.hint').textContent, hintClass: r.querySelector('.hint').className, who: r.querySelector('.who-did').textContent, whole: r.textContent }; });
// A saved world as the runtime makes it: the typed text sits in the serialized data, which is all the search reads.
const worldDoc = (text) => '<html><body><script type="text/x-lively-world">' + JSON.stringify({ registry: { 1: { storedString: text } } }) + '</script></body></html>';
const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const second = buildSecond(REPO, WORK), ID_A = idOfPackage(EXT), ID_B = second.id;
  const A = await launch(EXT, 'profile-transfer-a'), B = await launch(second.dir, 'profile-transfer-b');
  const FILE = path.join(WORK, 'keo-data-a.json'), BAD = path.join(WORK, 'keo-data-tampered.json'), OTHER = path.join(WORK, 'keo-data-other.json'), JUNK = path.join(WORK, 'keo-data-junk.json');
  try {
    for (const [P, id] of [[A, ID_A], [B, ID_B]]) { await P.page.goto(`chrome-extension://${id}/start.html#guest`); P.frame = await waitForWorld(P.page); }

    // ---- an identity on A, with saved worlds and a library
    const made = await call(A.page, () => window.keoIdentity.create({ label: 'Alice laptop' }));
    const DID = made.r && made.r.did;
    check('setup: A has a signed-in identity', made.ok && /^did:keo:/.test(DID), made);
    // ---- the entry a person has: the Identity menu, in a world that is signed in (before anything is saved: the plain page opens the
    // identity's last saved world, and these worlds are not real runtime worlds)
    await A.page.goto(`chrome-extension://${ID_A}/start.html`); A.frame = await waitForWorld(A.page);
    const entryUp = await poll(() => A.frame.evaluate(() => { const bar = $world.get(/MenuBar/), e = $world.get('IdentityMenuBarEntry') || (bar && bar.submorphs.filter((m) => m.name === 'IdentityMenuBarEntry')[0]); return !!(e && e.morphMenuItems().some((i) => i[0] === 'Identity')); }), 20000);
    check('A: signed in on the plain page, the menu bar has its identity entry', !!entryUp);
    const menu = await A.frame.evaluate(() => { const bar = $world.get(/MenuBar/), e = $world.get('IdentityMenuBarEntry') || bar.submorphs.filter((m) => m.name === 'IdentityMenuBarEntry')[0]; const sub = e.morphMenuItems().filter((i) => i[0] === 'Identity')[0][1]; const item = sub.filter((i) => /^Move my data/.test(i[0]))[0]; if (item) item[1](); return sub.map((i) => i[0]); });
    check('A: "Move my data ..." is under Identity, and choosing it puts the dialog up', menu.includes('Move my data ...') && !!(await poll(async () => { const x = await dlg(A); return x && !x.hidden ? x : null; }, 5000)), menu);
    // nothing saved yet: no file is made, and the person is told
    const gotFile = A.page.waitForEvent('download', { timeout: 2500 }).then(() => true, () => false);
    await A.page.click(SAVE);
    const emptyHint = await poll(async () => { const x = await dlg(A); return x && /nothing to save yet/.test(x.hint) ? x : null; }, 5000);
    check('A: with nothing saved yet, Save makes no file and says so', !(await gotFile) && !!emptyHint && emptyHint.result === '', emptyHint);
    await A.page.click(CLOSE);
    await sleep(11000);   // the shell refuses the world for a few seconds after a dialog was closed

    const PIC = 'picture bytes ' + 'x'.repeat(3000), OBJ = 'AAAAAAAAAAAA';
    const seeded = await call(A.page, async ([did, pic, obj, docs]) => {
      const w = window.keoWorlds, l = window.keoLibrary, kd = window.keoDid;
      await w.save({ name: 'First', doc: docs.first, tags: 'birds,sketch', note: 'my first' });
      await w.save({ name: 'Second', doc: docs.second, template: 'books' });
      await l.put({ objId: obj, doc: { objId: obj, did, type: 'book', record: { payload: { title: 'Sample Quartz' } } } });
      const bytes = new TextEncoder().encode(pic), cid = kd.b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
      await l.putBlob({ cid, bytes });
      return { cid, worlds: (await w.list()).length, found: (await w.search({ query: 'zebra' })).hits.map((h) => h.name) };
    }, [DID, PIC, OBJ, { first: worldDoc('zebra finch sketch'), second: worldDoc('quartz lamp notes') }]);
    check('setup: A has two saved worlds (searchable), a library item and a file', seeded.ok && seeded.r.worlds === 2 && seeded.r.found.join() === 'First', seeded);
    const CID = seeded.r && seeded.r.cid;

    // ---- B holds the same identity (linked the way the link dialog does it), and has data of its own
    const req = await call(B.page, () => window.keoIdentity.enrollRequest({ label: 'Alice desktop' }));
    const words = req.r.words.join(' ');
    const gr = await call(A.page, (a) => window.keoIdentity.enrollGrant(a), { did: DID, request: req.r.request, confirm: words });
    const pre = await call(B.page, (g) => window.keoIdentity.enrollPreview(g), gr.r);
    const done = await call(B.page, (a) => window.keoIdentity.enrollComplete(a), { grant: gr.r, confirm: pre.r.words.join(' ') });
    check('setup: B is linked to the identity and signed in as it', gr.ok && done.ok && (await call(B.page, async () => (await window.keoIdentity.current()).did)).r === DID, { gr: gr.err, done: done.err });
    const own = await call(B.page, async () => { await window.keoWorlds.save({ name: 'Second', doc: '<html><body>B own second</body></html>' }); return (await window.keoWorlds.list()).map((x) => x.name); });
    check('setup: B starts with a world of its own that has the same name as one of A', own.ok && own.r.join() === 'Second', own);

    // ---- the world can only ask
    const unknown = [];
    for (const name of ['transfer.save', 'transfer.add', 'transfer.read', 'transfer.import', 'transfer.export']) { const r = await op(A.frame, name); if (r.ok || !/unknown|no such|not (a )?known/i.test(r.e || '')) unknown.push([name, r]); }
    check('the world has no op that saves, adds or reads a file', unknown.length === 0, unknown);
    await A.page.bringToFront();
    const first = await op(A.frame, 'transfer.open');
    check('the world asks for the dialog', first.ok, first);
    const again = await op(A.frame, 'transfer.open');
    check('asked again while it is up, the world is refused', !again.ok && /already open/.test(again.e), again);
    let d = await dlg(A);
    check('the dialog is up, says whose data it is, and has said nothing yet', !!d && !d.hidden && /^keo:/.test(d.who) && d.result === '' && d.hint === '', d);

    // ---- A saves: a real click, a real download
    const [dl] = await Promise.all([A.page.waitForEvent('download', { timeout: 20000 }), A.page.click(SAVE)]);
    await dl.saveAs(FILE);
    check('A: Save gives a file named keo-data.json', dl.suggestedFilename() === 'keo-data.json');
    const text = fs.readFileSync(FILE, 'utf8'), j = JSON.parse(text);
    check('the file says what it is and whose it is, and holds two worlds, one item and one file', j.keo === 'data' && j.v === 1 && j.did === DID && j.worlds.bodies.length === 2 && j.worlds.texts.length === 2 && j.library.docs.length === 1 && j.library.blobs.length === 1, Object.keys(j));
    check('nothing in it is readable: no world text, no title, no name, no picture bytes', !/zebra|quartz|Sample|First|Second|birds|picture bytes|my first/.test(text));
    d = await poll(async () => { const x = await dlg(A); return /Saved keo-data\.json/.test(x.result) ? x : null; }, 10000);
    check('A: the dialog says what was saved, in counts', !!d && /2 saved worlds, 1 library item and 1 file/.test(d.result), d);
    const aAfter = await call(A.page, async () => (await window.keoWorlds.list()).map((x) => x.name).sort());
    check('A: saving changed nothing on A', aAfter.ok && aAfter.r.join() === 'First,Second', aAfter);
    await A.page.click(CLOSE);
    check('A: Close hides it', (await dlg(A)).hidden === true);

    // ---- files that must be refused or only partly used
    const tampered = JSON.parse(text); tampered.worlds.bodies.forEach((r) => { r.ct = flip(r.ct); });
    fs.writeFileSync(BAD, JSON.stringify(tampered));
    const other = JSON.parse(text); other.did = 'did:keo:zzzz:' + 'A'.repeat(43);
    fs.writeFileSync(OTHER, JSON.stringify(other));
    fs.writeFileSync(JUNK, 'this is not json');

    await B.page.bringToFront();
    check('B: asked for the dialog (the world only asks)', (await op(B.frame, 'transfer.open')).ok);
    const addFile = async (f) => {
      const [fc] = await Promise.all([B.page.waitForEvent('filechooser', { timeout: 10000 }), B.page.click(ADD)]);
      await fc.setFiles(f);
      return poll(async () => { const x = await dlg(B); return x && (x.result || (x.hintClass.includes('bad') && x.hint)) ? x : null; }, 15000);
    };
    d = await addFile(JUNK);
    check('B: a file that is not data is "not a valid keo data file" and nothing changes', !!d && /not a valid keo data file/.test(d.hint) && d.hintClass.includes('bad'), d);
    d = await addFile(OTHER);
    check('B: a file made for another identity is refused, naming it', !!d && /another identity \(keo:/.test(d.hint), d);
    check('B: still only its own world after those', (await call(B.page, async () => (await window.keoWorlds.list()).map((x) => x.name))).r.join() === 'Second');

    d = await addFile(BAD);
    check('B: a file with damaged worlds: the damaged one is not used, the one with a taken name is left alone, the library is added', !!d && /Added 0 saved worlds, 1 library item and 1 file/.test(d.result) && /Left alone because they are already here: 1 saved world \(Second\)/.test(d.result) && /Could not be used.*: 1/.test(d.result), d);
    const mid = await call(B.page, async ([obj, cid]) => ({ worlds: (await window.keoWorlds.list()).map((x) => x.name), doc: !!(await window.keoLibrary.get({ objId: obj })), blob: !!(await window.keoLibrary.getBlob({ cid })) }), [OBJ, CID]);
    check('B: only the good parts landed: no damaged world, its own world kept, the item and the file are there', mid.ok && mid.r.worlds.join() === 'Second' && mid.r.doc && mid.r.blob, mid);

    // ---- the good file
    d = await addFile(FILE);
    check('B: the good file adds the world that is missing, and leaves alone what is already there', !!d && /Added 1 saved world, 0 library items and 0 files/.test(d.result) && /already here: 1 saved world \(Second\), 1 library item, 1 file/.test(d.result), d);
    const after = await call(B.page, async ([obj, cid, pic]) => {
      const w = window.keoWorlds, l = window.keoLibrary, list = await w.list(), byName = {}; list.forEach((x) => { byName[x.name] = x; });
      const first = await w.load({ name: 'First' }), second = await w.load({ name: 'Second' });
      const hits = await w.search({ query: 'zebra' }), blob = await l.getBlob({ cid }), doc = await l.get({ objId: obj });
      return { names: list.map((x) => x.name).sort(), tags: byName.First && byName.First.tags, note: byName.First && byName.First.note, firstDoc: first && first.doc, secondDoc: second && second.doc,
        hit: hits.hits.map((h) => h.name), blobOk: new TextDecoder().decode(blob) === pic, title: doc && doc.record.payload.title };
    }, [OBJ, CID, PIC]);
    check('B: the world came with its text, tags and note', after.ok && after.r.names.join() === 'First,Second' && after.r.firstDoc.includes('zebra finch sketch') && after.r.tags.join() === 'birds,sketch' && after.r.note === 'my first', after);
    check('B: its own world with the taken name was NOT replaced', after.ok && after.r.secondDoc.includes('B own second') && !after.r.secondDoc.includes('quartz'), after);
    check('B: searching finds text from the world that came across', after.ok && after.r.hit.join() === 'First', after);
    check('B: the library item and the file are there, byte for byte', after.ok && after.r.title === 'Sample Quartz' && after.r.blobOk, after);
    d = await addFile(FILE);
    check('B: adding the same file again changes nothing and says so', !!d && /Added 0 saved worlds, 0 library items and 0 files/.test(d.result) && /already here/.test(d.result), d);
    const same = await call(B.page, async () => (await window.keoWorlds.list()).length);
    check('B: still two worlds', same.ok && same.r === 2, same);
    await B.page.click(CLOSE);

    // ---- large files: kept in chunks, moved in a second form of the file that is read a piece at a time
    const SZ = { 'large-one.bin': 2 * 4194304 + 777, 'large-two.bin': 4194304, 'large-three.bin': 15 * 4194304 }, CH = { 'large-one.bin': 3, 'large-two.bin': 1, 'large-three.bin': 15 };
    const LARGE = await call(A.page, async (list) => {
      const L = window.keoLibrary, kd = window.keoDid, out = [], marker = 'KEO-BIG-MARKER-KEO-BIG-MARKER';
      for (const [name, n, seed] of list) {
        const u = new Uint8Array(n); let x = seed;
        for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; u[i] = x & 255; }
        if (name === 'large-one.bin') for (let i = 0; i + marker.length < n; i += 1000) for (let j = 0; j < marker.length; j++) u[i + j] = marker.charCodeAt(j);
        const b = await L.fileBegin({ name, type: 'application/octet-stream', size: n }); let k = 0;
        for (let o = 0; o < n; o += b.chunkBytes) await L.fileChunk({ upload: b.upload, n: k++, bytes: u.slice(o, Math.min(o + b.chunkBytes, n)) });
        const end = await L.fileEnd({ upload: b.upload });
        out.push({ name, id: end.id, cid: kd.b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', u))), size: n });
      }
      return out;
    }, [['large-one.bin', SZ['large-one.bin'], 5], ['large-two.bin', SZ['large-two.bin'], 6], ['large-three.bin', SZ['large-three.bin'], 7]]);
    check('setup: A has three large files (three, one and fifteen chunks)', LARGE.ok && LARGE.r.length === 3 && LARGE.r.every((x) => x.id === x.cid), LARGE);
    const IDS = {}; (LARGE.r || []).forEach((x) => { IDS[x.name] = x.id; });
    await sleep(11000);
    await A.page.bringToFront();
    check('A: the dialog opens again', (await op(A.frame, 'transfer.open')).ok);
    const BIGF = path.join(WORK, 'keo-data-big.keo');
    const [dl2] = await Promise.all([A.page.waitForEvent('download', { timeout: 60000 }), A.page.click(SAVE)]);
    await dl2.saveAs(BIGF);
    check('A: with large files the download is named keo-data.keo', dl2.suggestedFilename() === 'keo-data.keo');
    const big = fs.readFileSync(BIGF);
    check('the second form starts with its marker', big.slice(0, 6).toString() === 'KEOD2\n');
    check('nothing in it is readable: no file name, no marker text, no title', big.indexOf('large-') < 0 && big.indexOf('KEO-BIG-MARKER') < 0 && big.indexOf('Sample Quartz') < 0 && big.indexOf('zebra') < 0);
    d = await poll(async () => { const x = await dlg(A); return /Saved keo-data\.keo/.test(x.result) ? x : null; }, 30000);
    check('A: the dialog says what was saved, large files counted apart', !!d && /2 saved worlds, 1 library item, 1 file and 3 large files/.test(d.result), d);
    await A.page.click(CLOSE);
    const parse = (buf) => { let off = 6; const fr = []; while (off + 5 <= buf.length) { const len = buf.readUInt32BE(off + 1); fr.push({ type: buf[off], start: off, len, end: off + 5 + len }); off += 5 + len; } return fr; };
    const frs = parse(big), groups = []; let curG = null;
    for (const fr of frs.slice(1)) { if (fr.type === 2) { curG = { man: fr, chunks: [] }; groups.push(curG); } else if (fr.type === 3) curG.chunks.push(fr); }
    const nameOf = (g) => Object.keys(CH).find((n) => CH[n] === g.chunks.length);
    check('the frames: one text frame, three manifests, nineteen chunks, one end mark', frs[0].type === 1 && groups.length === 3 && groups.reduce((a, g) => a + g.chunks.length, 0) === 19 && frs[frs.length - 1].type === 4 && frs[frs.length - 1].end === big.length, groups.map((g) => g.chunks.length));

    const bStat = () => call(B.page, async () => {
      const idb = (st) => new Promise((res, rej) => { const q = indexedDB.open('keo-library'); q.onerror = () => rej(q.error); q.onsuccess = () => { const db = q.result, r = db.transaction(st).objectStore(st).getAll(); r.onsuccess = () => { db.close(); res(r.result); }; }; });
      const found = await window.keoLibrary.fileSearch({ query: 'large-', limit: 200 }), tot = await idb('blobtotal');
      return { names: found.items.map((i) => i.name).sort(), chunks: (await idb('chunks')).length, pending: (await idb('pending')).length, total: tot[0] ? tot[0].total : 0 };
    });
    const removeLarge = () => call(B.page, async (ids) => { for (const id of ids) await window.keoLibrary.fileRemove({ id }); return true; }, Object.values(IDS));
    const hashesOk = (names) => call(B.page, async (list) => {
      const out = {};
      for (const [name, id] of list) {
        const info = await window.keoLibrary.fileInfo({ id }); const parts = [];
        for (let n = 0; n < info.chunks; n++) parts.push(await window.keoLibrary.fileRead({ id, n }));
        const all = new Uint8Array(await new Blob(parts).arrayBuffer()), h = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
        let t = ''; for (const b of h) t += String.fromCharCode(b);
        out[name] = btoa(t).split('+').join('-').split('/').join('_').split('=').join('') === id && info.name === name && info.size === all.length;
      }
      return out;
    }, names.map((n) => [n, IDS[n]]));
    const sumOf = (names) => names.reduce((a, n) => a + SZ[n], 0), chunksOf = (names) => names.reduce((a, n) => a + CH[n], 0);
    const base = (await bStat()).r;

    await sleep(11000);
    await B.page.bringToFront();
    check('B: asked for the dialog', (await op(B.frame, 'transfer.open')).ok);
    d = await addFile(BIGF);
    check('B: the large files are added and counted, with their size', !!d && /Added 0 saved worlds, 0 library items, 0 files and 3 large files \(72\.0 MB\)/.test(d.result), d);
    let st = (await bStat()).r;
    check('B: all three are there, their chunks too, nothing left unfinished, and the total grew by their size', st.names.join() === 'large-one.bin,large-three.bin,large-two.bin' && st.chunks === 19 && st.pending === 0 && st.total === base.total + sumOf(Object.keys(SZ)), st);
    const hv = (await hashesOk(Object.keys(SZ))).r;
    check('B: each one reads back whole, and its bytes come to its name (the hash), name and size', hv && Object.values(hv).every(Boolean) && Object.keys(hv).length === 3, hv);
    d = await addFile(BIGF);
    check('B: adding the same file again adds nothing and says they are already here', !!d && /and 0 large files/.test(d.result) && /3 large files/.test(d.result.split('already here')[1] || ''), d);
    st = (await bStat()).r;
    check('B: and the stores did not grow', st.chunks === 19 && st.total === base.total + sumOf(Object.keys(SZ)), st);

    // ---- files that are cut, changed or wrong: every case starts from B without the large files
    const victim = groups.find((g) => g.chunks.length === 15), vName = nameOf(victim), vIdx = groups.indexOf(victim);
    const others = Object.keys(SZ).filter((n) => n !== vName), before = groups.slice(0, vIdx).map(nameOf);
    const CASE = path.join(WORK, 'keo-data-case.keo');
    const run = async (buf, expect) => {
      fs.writeFileSync(CASE, buf);
      await removeLarge();
      const dd = await addFile(CASE);
      await expect(dd, (await bStat()).r);
    };
    const flipAt = (buf, at) => { const b = Buffer.from(buf); b[at] ^= 1; return b; };
    await run(big.slice(0, victim.chunks[0].end), (dd, got) => {
      check('B: a file cut short: the files before it are added, the cut one is not, and the person is told it stops early', !!dd && got.names.join() === before.slice().sort().join() && /stops early or is damaged/.test(dd.result), { dd, got, before });
      check('B: what the cut file stored is gone (chunks only for the added files, none unfinished)', got.chunks === chunksOf(before) && got.pending === 0 && got.total === base.total + sumOf(before), got);
    });
    await run(flipAt(big, victim.chunks[1].start + 5 + 12 + 100), (dd, got) => {
      check('B: one changed bit in a chunk: that file is not added, the others are, and it says so', !!dd && got.names.join() === others.slice().sort().join() && /Could not be used \(damaged, or not valid here\): 1/.test(dd.result) && !/stops early/.test(dd.result), { dd, got });
      check('B: and nothing of it is left behind', got.chunks === chunksOf(others) && got.pending === 0 && got.total === base.total + sumOf(others), got);
    });
    const manBuf = Buffer.from(big), ctAt = manBuf.slice(victim.man.start, victim.man.end).indexOf('"ct":"') + victim.man.start + 6 + 20;
    manBuf[ctAt] = manBuf[ctAt] === 65 ? 66 : 65;
    await run(manBuf, (dd, got) => {
      check('B: a changed manifest: that file is not added (and its chunks are skipped, not misread), the others are', !!dd && got.names.join() === others.slice().sort().join() && /Could not be used \(damaged, or not valid here\): 1/.test(dd.result) && got.chunks === chunksOf(others) && got.pending === 0, { dd, got });
    });
    const swapBuf = Buffer.from(big), c0 = victim.chunks[0], c1 = victim.chunks[1];
    big.slice(c0.start + 5, c0.end).copy(swapBuf, c1.start + 5); big.slice(c1.start + 5, c1.end).copy(swapBuf, c0.start + 5);
    await run(swapBuf, (dd, got) => {
      check('B: two chunks of one file swapped: refused (each is sealed to its own place), the others are added', !!dd && got.names.join() === others.slice().sort().join() && /Could not be used/.test(dd.result) && got.chunks === chunksOf(others), { dd, got });
    });
    const didBuf = Buffer.from(big), didAt = didBuf.slice(frs[0].start + 5, frs[0].end).indexOf('"did":"did:keo:') + frs[0].start + 5 + 40;
    didBuf[didAt] = didBuf[didAt] === 65 ? 66 : 65;
    await run(didBuf, (dd, got) => {
      check('B: data made for another identity is refused, naming it, and nothing is added', !!dd && /another identity \(keo:/.test(dd.hint) && got.names.length === 0 && got.chunks === 0, { dd, got });
    });
    await run(big.slice(0, frs[0].end - 10), (dd, got) => {
      check('B: a file that ends inside its first part is refused with a sentence, and nothing changes', !!dd && /ends too early/.test(dd.hint) && got.chunks === 0 && got.names.length === 0, { dd, got });
    });
    const typeBuf = Buffer.from(big); typeBuf[frs[0].start] = 2;
    await run(typeBuf, (dd, got) => {
      check('B: a file whose first part is of the wrong kind is "not a valid keo data file"', !!dd && /not a valid keo data file/.test(dd.hint) && got.chunks === 0, { dd, got });
    });
    const lenBuf = Buffer.from(big); lenBuf.writeUInt32BE(0xffffffff, frs[0].start + 1);
    await run(lenBuf, (dd, got) => {
      check('B: a first part that claims an absurd length is refused as damaged', !!dd && /damaged/.test(dd.hint) && got.chunks === 0, { dd, got });
    });
    await run(Buffer.from('KEOD2\n'), (dd, got) => {
      check('B: a file with only the marker is "not a valid keo data file"', !!dd && /not a valid keo data file/.test(dd.hint) && got.chunks === 0, { dd, got });
    });
    d = await addFile(BIGF);
    check('B: after all that the good file still adds all three', !!d && /and 3 large files \(72\.0 MB\)/.test(d.result), d);
    const hv2 = (await hashesOk(Object.keys(SZ))).r;
    check('B: and they read back whole', hv2 && Object.values(hv2).every(Boolean), hv2);
    await B.page.click(CLOSE);

  } catch (e) { check('the test crashed: ' + (e && e.message), false, e && e.stack); }
  finally { await A.ctx.close().catch(() => {}); await B.ctx.close().catch(() => {}); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
