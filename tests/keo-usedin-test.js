// "Used in": which saved worlds show which library files (shell: keo-worlds.js usedIn, keo-worldtext.js fileIds, bridge op world.usedIn;
// kernel: lively.identity.LocalFiles usedIn / worldHolds, lively.identity.MyFilesBrowser). Checks: files placed in two worlds and saved
// are found in exactly those worlds; a file no world shows has an empty list; the preview's "Used in" line (real clicks) names the worlds,
// says "No saved world", and names the open world when it shows the file but is not saved yet; the question before a removal names the
// worlds that show the file and is unchanged for a file nothing shows; removing a world takes it out; a world saved again is read again
// and one that did not change is not (the number of decryptions is counted); a world whose body cannot be read is counted, never guessed
// at, and does not stop the others; the answer holds nothing but names and lists.
// Usage: node keo-usedin-test.js <repo root> <extension folder> <work dir>
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
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
  if (!frame) throw new Error('the world did not start as ' + kind);
  await sleep(2500);
  return frame;
}
const keoCall = (frame, op, args) => frame.evaluate(([o, a]) => window.keo.call(o, a, 120000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [op, args || {}]);
async function until(fn, ms) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > (ms || 15000)) return v; await sleep(250); } }
const click = (frame, sel, opts) => frame.click(sel, Object.assign({ timeout: 8000 }, opts || {}));

// a button of a question the world asks (found by its label) clicked for real
const answer = async (page, frame, re) => {
  const r = await frame.evaluate((src) => { const re = new RegExp(src, 'i'); let found = null; (function walk(m) { if (found) return; if (m instanceof lively.morphic.Button && re.test(String(m.getLabel ? m.getLabel() : ''))) found = m; (m.submorphs || []).forEach(walk); })($world); if (!found) return null; const b = found.renderContext().shapeNode.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, re.source);
  if (!r) return false;
  const off = await (await frame.frameElement()).boundingBox();
  await page.mouse.click(off.x + r.x + r.w / 2, off.y + r.y + r.h / 2);
  return true;
};
// the text of the question the world is asking (the one that mentions the library), or null
const questionText = (frame) => frame.evaluate(() => { let t = null; (function walk(m) { if (t) return; if (typeof m.textString === 'string' && /Worlds that show (it|them) will not be able to show (it|them) any more/.test(m.textString)) t = m.textString; (m.submorphs || []).forEach(walk); })($world); return t; });
const OPEN = () => new Promise((res) => lively.require('lively.identity.MyFilesBrowser').toRun(() => { lively.identity.MyFilesBrowser.open(); res(); }));
// (functions sent to the page must hold everything they use: they cannot see this file's own names)
const PLACE = (id) => { const w = $world.submorphs.find((m) => m.name === 'MyFilesBrowser'); let t = null; (function walk(m) { if (t) return; if (typeof m.place === 'function' && typeof m.saveCopy === 'function') t = m; (m.submorphs || []).forEach(walk); })(w); t.place([id]); return true; };
const SAVE = () => new Promise((res) => $world.saveWorld(() => res(true)));
const USED = () => { const root = document.querySelector('.mf-root'); const dd = root && root.querySelector('[data-el="usedin"]'); return dd ? dd.innerText.replace(/\s+/g, ' ').trim() : null; };
const R = (s) => '.mf-root ' + s;
const row = (id) => R('.mf-row[data-id="' + id + '"] .mf-txt');

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-usedin-' + Date.now()), {
    headless: false, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    await page.goto(`chrome-extension://${ID}/start.html`);
    let frame = await waitForWorld(page, 'gate');
    await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }));
    await keoCall(frame, 'world.go', { kind: 'enter' }).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    await keoCall(frame, 'world.go', { kind: 'blank', name: 'Alpha' }).catch(() => {});
    frame = await waitForWorld(page, 'blank', 'Alpha');

    // ---- four pictures in the library; Alpha shows A and B, Beta will show B
    const ids = await frame.evaluate(async () => {
      const png = (colour) => new Promise((r) => { const c = document.createElement('canvas'); c.width = 30; c.height = 20; const g = c.getContext('2d'); g.fillStyle = colour; g.fillRect(0, 0, 30, 20); c.toBlob(r, 'image/png'); });
      const out = {};
      for (const [k, colour] of [['A', '#c8285a'], ['B', '#2f9e5b'], ['C', '#2563eb'], ['D', '#e8a317']]) { const blob = await png(colour); out[k] = await new Promise((res) => lively.identity.localFiles.put(new File([blob], 'dot' + k + '.png', { type: 'image/png' }), {}, (e, r) => res(e ? null : r.id))); }
      return out;
    });
    check('setup: four pictures are in the library', Object.values(ids).every((v) => typeof v === 'string' && v.length === 43), ids);
    await frame.evaluate(OPEN);
    await until(async () => (await frame.evaluate(() => document.querySelectorAll('.mf-row').length)) === 4, 15000);
    await frame.evaluate(PLACE, ids.A); await sleep(400); await frame.evaluate(PLACE, ids.B); await sleep(800);
    check('setup: A and B are placed in Alpha (two picture morphs hold library references)', (await frame.evaluate(() => { const n = []; $world.withAllSubmorphsDo((m) => { if (m.shape && m.shape.fileHandle === 'keo:local') n.push(m.shape.fileObjId); }); return n.sort(); })).join() === [ids.A, ids.B].sort().join());
    await frame.evaluate(SAVE);
    check('Alpha is saved', (await keoCall(frame, 'world.has', { name: 'Alpha' })).r === true);

    await keoCall(frame, 'world.go', { kind: 'blank', name: 'Beta' }).catch(() => {});
    frame = await waitForWorld(page, 'blank', 'Beta');
    await frame.evaluate(OPEN);
    await until(async () => (await frame.evaluate(() => document.querySelectorAll('.mf-row').length)) === 4, 15000);
    await frame.evaluate(PLACE, ids.B); await sleep(800);
    await frame.evaluate(SAVE);

    // ---- the shell's answer
    await page.evaluate(() => { window.__dec = 0; const o = crypto.subtle.decrypt.bind(crypto.subtle); crypto.subtle.decrypt = function () { window.__dec++; return o.apply(null, arguments); }; });
    const all = [ids.A, ids.B, ids.C, ids.D];
    await frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'MyFilesBrowser'); if (w) w.remove(); });
    await sleep(1500);
    await page.evaluate(() => { window.__dec = 0; });
    let u = await keoCall(frame, 'world.usedIn', { ids: all });
    const dec1 = await page.evaluate(() => window.__dec);
    check('A is shown in Alpha only, B in Alpha and Beta, C and D in no saved world, and nothing was unreadable', u.ok && JSON.stringify(u.r[ids.A]) === '["Alpha"]' && JSON.stringify(u.r[ids.B]) === '["Alpha","Beta"]' && JSON.stringify(u.r[ids.C]) === '[]' && JSON.stringify(u.r[ids.D]) === '[]' && u.r._unreadable === 0, u);
    check('the answer holds only the asked ids and the count: names and lists, nothing else', u.ok && Object.keys(u.r).sort().join() === all.concat(['_unreadable']).sort().join() && Object.values(u.r).every((v) => v === 0 || (Array.isArray(v) && v.every((n) => typeof n === 'string'))), u.ok && Object.keys(u.r));
    await page.evaluate(() => { window.__dec = 0; });
    u = await keoCall(frame, 'world.usedIn', { ids: all });
    const dec2 = await page.evaluate(() => window.__dec);
    check('asked again with nothing saved since: no world body is opened (one decryption, the index), and the answer is the same', dec2 === 1 && dec1 >= 3 && JSON.stringify(u.r[ids.B]) === '["Alpha","Beta"]', [dec1, dec2]);

    // ---- the window: the preview's "Used in" line, by real clicks
    await frame.evaluate(OPEN);
    await until(async () => (await frame.evaluate(() => document.querySelectorAll('.mf-row').length)) === 4, 15000);
    const usedLine = async (id) => { await click(frame, row(id)); return until(async () => { const v = await frame.evaluate(USED); return v && !/checking/.test(v) ? v : null; }, 15000); };
    check('the preview of A says it is used in Alpha', (await usedLine(ids.A)) === 'Alpha');
    check('the preview of B says Alpha and Beta', (await usedLine(ids.B)) === 'Alpha, Beta');
    check('the preview of C says No saved world', (await usedLine(ids.C)) === 'No saved world');

    // ---- the open world shows C but has not saved it
    await frame.evaluate(PLACE, ids.C); await sleep(800);
    check('the preview of C now says this world (not saved yet), without choosing it again: placing a file refreshes the line', !!(await until(async () => (await frame.evaluate(USED)) === 'this world (not saved yet)', 8000)));

    // ---- the question before a removal
    const chosen = () => frame.evaluate(() => [...document.querySelectorAll('.mf-row.sel')].map((r) => (r.querySelector('.mf-nmx') || {}).title));
    // (a file just placed in the world comes to the front; the window is brought forward again, as the thumbnails test does, so the click is not spent on that)
    await frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'MyFilesBrowser'); if (w) w.comeForward(); });
    await click(frame, row(ids.B));
    const picked = await until(async () => ((await chosen()).join() === 'dotB.png' ? true : null), 6000);
    check('setup: the click chose B (and only B)', !!picked, await chosen());
    await click(frame, R('.mf-prev [data-act=remove]'));
    let q = await until(() => questionText(frame), 15000);
    check('removing B asks, and says it is shown in 2 saved worlds, Alpha and Beta, before the usual words', !!q && /^“dotB\.png” is shown in 2 saved worlds: Alpha, Beta\. Remove “dotB\.png” \(.*\) from your library\? Worlds that show it will not be able to show it any more\. This cannot be undone\.$/.test(q), q);
    check('the question can be turned down with a click, and nothing was removed', await answer(page, frame, /^(Cancel|No)$/) && !!(await until(async () => !(await questionText(frame)), 6000)) && (await keoCall(frame, 'library.fileInfo', { id: ids.B })).r !== null);
    await click(frame, row(ids.C));
    await click(frame, R('.mf-prev [data-act=remove]'));
    q = await until(() => questionText(frame), 15000);
    check('removing C (shown only in the open world, not saved) names that world', !!q && /^“dotC\.png” is shown in this world \(not saved yet\)\. Remove /.test(q), q);
    await answer(page, frame, /^(Cancel|No)$/);
    await until(async () => !(await questionText(frame)), 6000);
    await click(frame, row(ids.D));
    await click(frame, R('.mf-prev [data-act=remove]'));
    q = await until(() => questionText(frame), 15000);
    check('removing D (shown nowhere) asks exactly as it always did', !!q && /^Remove “dotD\.png” \(.*\) from your library\? Worlds that show it will not be able to show it any more\. This cannot be undone\.$/.test(q), q);
    await answer(page, frame, /^(Cancel|No)$/);
    await until(async () => !(await questionText(frame)), 6000);

    // ---- saving the open world takes C into the saved list; a world saved again is read again, the others are not
    await frame.evaluate(() => { const w = $world.submorphs.find((m) => m.name === 'MyFilesBrowser'); if (w) w.remove(); });
    await frame.evaluate(SAVE);
    await sleep(1500);
    await page.evaluate(() => { window.__dec = 0; });
    u = await keoCall(frame, 'world.usedIn', { ids: all });
    const dec3 = await page.evaluate(() => window.__dec);
    check('Beta was saved again: C is now in Beta, and only Beta was read again (the index and one body)', JSON.stringify(u.r[ids.C]) === '["Beta"]' && JSON.stringify(u.r[ids.B]) === '["Alpha","Beta"]' && dec3 === 2, [u.r, dec3]);

    // ---- a world removed, and a picture taken out of a world
    await keoCall(frame, 'world.remove', { name: 'Alpha' });
    u = await keoCall(frame, 'world.usedIn', { ids: all });
    check('after Alpha is removed, A is in no world and B only in Beta', JSON.stringify(u.r[ids.A]) === '[]' && JSON.stringify(u.r[ids.B]) === '["Beta"]', u.r);
    await frame.evaluate(() => { $world.withAllSubmorphsDo((m) => { if (m.shape && m.shape.fileObjId) m.remove(); }); });
    await frame.evaluate(SAVE);
    u = await keoCall(frame, 'world.usedIn', { ids: all });
    check('after the pictures are taken out of Beta and it is saved, no file is shown anywhere', all.every((id) => JSON.stringify(u.r[id]) === '[]'), u.r);

    // ---- worlds made by the world.save op with their own text: exactly the file morphs count, and a window's markup does not
    const doc = (registry, extra) => '<html><body>' + (extra || '') + '<script type="text/x-lively-world">' + JSON.stringify({ registry: Object.assign({ isSimplifiedRegistry: true }, registry) }) + '</script></body></html>';
    await keoCall(frame, 'world.save', { name: 'Crafted', doc: doc({ '1': { fileHandle: 'keo:local', fileObjId: ids.D }, '2': { fileHandle: 'other', fileObjId: ids.A }, '3': { _sig: ids.C } }, '<div data-id="' + ids.C + '"></div>') });
    u = await keoCall(frame, 'world.usedIn', { ids: all });
    check('a world that holds a library reference to D, a reference through some other handle to A, and the id of C in markup and state: only D counts', JSON.stringify(u.r[ids.D]) === '["Crafted"]' && JSON.stringify(u.r[ids.A]) === '[]' && JSON.stringify(u.r[ids.C]) === '[]', u.r);
    check('a request with no ids, a request with something that is not an id, and a request with too many ids all answer without error', (await keoCall(frame, 'world.usedIn', { ids: [] })).ok && (await keoCall(frame, 'world.usedIn', { ids: ['not an id'] })).r['not an id'].length === 0 && (await keoCall(frame, 'world.usedIn', { ids: Array.from({ length: 700 }, (_, i) => 'x' + i) })).ok && (await keoCall(frame, 'world.usedIn', {})).ok);

    // ---- a world whose body cannot be read is counted, and the others still answer
    const keysOf = () => page.evaluate(() => new Promise((res, rej) => { const o = indexedDB.open('keo-worlds'); o.onsuccess = () => { const r = o.result.transaction('bodies').objectStore('bodies').getAllKeys(); r.onsuccess = () => { o.result.close(); res(r.result); }; r.onerror = () => rej(r.error); }; o.onerror = () => rej(o.error); }));
    const before = await keysOf();
    await keoCall(frame, 'world.save', { name: 'Broken', doc: doc({ '1': { fileHandle: 'keo:local', fileObjId: ids.A } }) });
    const added = (await keysOf()).filter((k) => !before.includes(k));
    check('setup: saving Broken made one new body record', added.length === 1, added);
    await page.evaluate((key) => new Promise((res, rej) => { const o = indexedDB.open('keo-worlds'); o.onsuccess = () => { const t = o.result.transaction('bodies', 'readwrite'), s = t.objectStore('bodies'), g = s.get(key); g.onsuccess = () => { const rec = g.result; rec.ct = new Uint8Array(rec.ct.length).fill(7); s.put(rec); }; t.oncomplete = () => { o.result.close(); res(); }; t.onerror = () => rej(t.error); }; }), added[0]);
    u = await keoCall(frame, 'world.usedIn', { ids: all });
    check('with Broken\'s body damaged: it is counted as unreadable and not guessed at, and the other worlds still answer', u.ok && u.r._unreadable === 1 && JSON.stringify(u.r[ids.A]) === '[]' && JSON.stringify(u.r[ids.D]) === '["Crafted"]', u.r);
    await frame.evaluate(OPEN);
    await until(async () => (await frame.evaluate(() => document.querySelectorAll('.mf-row').length)) === 4, 15000);
    check('and the preview says so', (await usedLine(ids.D)) === 'Crafted (1 saved world could not be read)');

    check('no page errors', errors.length === 0, errors);
    await page.screenshot({ path: path.join(WORK, 'usedin.png') });
  } catch (e) {
    check('the run finished without an exception', false, String(e && e.stack || e));
  }
  await ctx.close();
  console.log(failed ? 'FAILED: ' + failed : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
