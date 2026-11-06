// End-to-end test of the worlds library in the built keo extension: create a world by name, save, search (names, tags, notes and the
// text inside worlds), rename, duplicate, tags and notes, delete, what is on disk, and a database made by the version before.
// Usage: node keo-worlds-test.js <repo root> <extension folder> <work dir>
// A headed browser with the extension loaded, `localhost` unresolvable, and a CDP virtual authenticator with PRF (so nothing here
// says anything about a real authenticator). Worlds are made and saved by the runtime itself, so what is searched is what the
// runtime really writes. The shell's own functions are called through the bridge op where one exists, as the world would.
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'cgjphijackijgcjkfdfieihkbfooigjp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 900) : '')); if (!ok) failed++; }
const errors = [];

const worldFrame = (page) => page.frames().find((f) => /world\.html$/.test(f.url()));
async function waitForWorld(page, kind) {
  let frame = null;
  for (let i = 0; i < 200; i++) {
    frame = worldFrame(page);
    if (frame) { try { if (await frame.evaluate((k) => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind === k), kind)) break; } catch (e) {} }
    frame = null; await sleep(300);
  }
  if (!frame) throw new Error('the world did not start as ' + kind);
  await sleep(2500);       // the page-specific setup (menu, the first save of a named world) runs after the world is up
  return frame;
}
const keoCall = (frame, op, args) => frame.evaluate(([o, a]) => window.keo.call(o, a, 60000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [op, args || {}]);
// the same op, asked of the shell page directly (what the bridge would call)
const shellCall = (page, fn, args) => page.evaluate(([f, a]) => window.keoWorlds[f](a).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [fn, args || {}]);
async function until(fn, ms) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > (ms || 15000)) return v; await sleep(300); } }
const names = (l) => l.map((w) => w.name).sort();

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-worlds'), {
    headless: false, viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure|ERR_FILE_NOT_FOUND|ERR_NAME_NOT_RESOLVED|ERR_FAILED/.test(m.text()) && /keo-worlds|keo-worldtext|shell\.js/.test(m.location().url || '')) errors.push('console: ' + m.text().slice(0, 200)); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });

    await page.goto(`chrome-extension://${ID}/start.html`);
    let frame = await waitForWorld(page, 'gate');
    await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }));
    await keoCall(frame, 'world.go', { kind: 'enter' }).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    check('setup: the shell offers the library functions', await page.evaluate(() => ['save', 'list', 'has', 'rename', 'setMeta', 'duplicate', 'search', 'remove'].every((f) => typeof window.keoWorlds[f] === 'function') && !!window.keoWorldText));

    // ---- 1. create a world by name
    await keoCall(frame, 'world.go', { kind: 'blank', name: '  Alpha   notes ' }).catch(() => {});
    frame = await waitForWorld(page, 'blank');
    let l = await until(async () => { const r = (await keoCall(frame, 'world.list')).r; return r.length ? r : null; });
    check('create: a world made with a name is in the library at once, under the cleaned name', l && l.length === 1 && l[0].name === 'Alpha notes' && l[0].last === true, l);
    check('create: it has a creation date, no tags and no note', l && l[0].createdAt && l[0].createdAt === l[0].savedAt && l[0].tags.length === 0 && l[0].note === '', l);
    check('create: the running world knows its name (a plain save keeps it)', (await frame.evaluate(() => window.keo.init.startup.name)) === 'Alpha notes');
    const taken = await keoCall(frame, 'world.go', { kind: 'blank', name: 'Alpha notes' });
    check('create: a name that is taken is refused, and nothing was replaced', !taken.ok && /already exists/.test(taken.e) && (await keoCall(frame, 'world.list')).r.length === 1, taken);
    check('create: has() says so', (await keoCall(frame, 'world.has', { name: 'Alpha notes' })).r === true && (await keoCall(frame, 'world.has', { name: 'Nope' })).r === false);

    // ---- 2. text typed into the world is what the runtime writes, and it is found
    await frame.evaluate(() => { const t = new lively.morphic.Text(lively.rect(30, 90, 260, 40), 'Pineapple fritters for the picnic'); t.setName('picnic-list'); $world.addMorph(t); });
    const saved = await frame.evaluate(() => new Promise((res) => $world.saveWorld((e) => res(e ? { err: e.message } : { ok: true }))));
    check('save: a plain save of the named world works and keeps the name', saved.ok === true && names((await keoCall(frame, 'world.list')).r).join() === 'Alpha notes', saved);
    const doc = (await keoCall(frame, 'world.load', { name: 'Alpha notes' })).r.doc;
    const extracted = await page.evaluate((d) => window.keoWorldText.extract(d), doc);
    console.log('INFO extracted text of the saved world: ' + JSON.stringify(extracted.slice(0, 300)));
    check('extract: what the runtime wrote holds the typed text and the morph name', /Pineapple fritters for the picnic/.test(extracted) && /picnic-list/.test(extracted), extracted.slice(0, 300));
    check('extract: and none of the runtime\'s own markup, nor the menu text the world only remembers', !/lively\.morphic|<div|Color\.rgb|Save world/.test(extracted), extracted.slice(0, 300));
    let r = await keoCall(frame, 'world.search', { query: 'pineapple' });
    check('search: the text inside a world is found, with a snippet around it', r.ok && r.r.hits.length === 1 && r.r.hits[0].name === 'Alpha notes' && r.r.hits[0].where.includes('text') && /Pineapple fritters/.test(r.r.hits[0].snippet), r);
    r = await keoCall(frame, 'world.search', { query: 'PINEAPPLE picnic' });
    check('search: every word, in any case', r.ok && r.r.hits.length === 1, r);
    r = await keoCall(frame, 'world.search', { query: 'pineapple kiwi' });
    check('search: a word that is nowhere gives no hit', r.ok && r.r.hits.length === 0, r);
    r = await keoCall(frame, 'world.search', { query: '   ' });
    check('search: an empty query gives nothing, not everything', r.ok && r.r.hits.length === 0, r);

    // ---- 3. a name with characters that look like an address
    const odd = 'Plans a/b? #1 100%';
    const sv = await frame.evaluate((n) => new Promise((res) => $world.saveWorldAs(URL.root.withFilename(encodeURIComponent(n) + '.html'), false, undefined, (e) => res(e ? { err: e.message } : { ok: true }))), odd);
    l = (await keoCall(frame, 'world.list')).r;
    check('names: a name with / ? # % is kept whole', sv.ok === true && names(l).includes(odd), { sv, names: names(l) });

    // ---- 4. tags and notes
    let m = await keoCall(frame, 'world.meta', { name: 'Alpha notes', tags: ' Food, picnic , food, ', note: 'summer ideas' });
    check('meta: tags are trimmed and the same tag is kept once whatever its case', m.ok && JSON.stringify(m.r.tags) === JSON.stringify(['Food', 'picnic']) && m.r.note === 'summer ideas', m);
    m = await keoCall(frame, 'world.meta', { name: 'Alpha notes', note: 'summer ideas, revised' });
    check('meta: leaving the tags out keeps them', m.ok && m.r.tags.length === 2 && m.r.note === 'summer ideas, revised', m);
    check('meta: too many tags are refused', !(await keoCall(frame, 'world.meta', { name: 'Alpha notes', tags: Array.from({ length: 17 }, (_, i) => 't' + i) })).ok);
    check('meta: a note that is too long is refused', !(await keoCall(frame, 'world.meta', { name: 'Alpha notes', note: 'x'.repeat(1001) })).ok);
    check('meta: a world that does not exist is refused', !(await keoCall(frame, 'world.meta', { name: 'Nope', tags: ['a'] })).ok);
    r = await keoCall(frame, 'world.search', { query: 'food' });
    check('search: tags are searched', r.ok && r.r.hits.length === 1 && r.r.hits[0].where.join() === 'tags', r);
    r = await keoCall(frame, 'world.search', { query: 'revised' });
    check('search: the note is searched', r.ok && r.r.hits.length === 1 && r.r.hits[0].where.join() === 'note', r);
    r = await keoCall(frame, 'world.search', { query: 'alpha' });
    check('search: the name is searched', r.ok && r.r.hits.length === 1 && r.r.hits[0].where.join() === 'name', r);
    // The running world now carries the name of the world saved just before (the odd one), so the second save of 'Alpha notes' is made
    // through the shell, as the runtime's save would for that name.
    const alphaBefore = (await keoCall(frame, 'world.list')).r.filter((w) => w.name === 'Alpha notes')[0];
    await sleep(20);
    await shellCall(page, 'save', { name: 'Alpha notes', doc });
    l = (await keoCall(frame, 'world.list')).r.filter((w) => w.name === 'Alpha notes')[0];
    check('save: saving again keeps the tags, the note and the creation date, and moves the saved date', l.tags.join() === 'Food,picnic' && l.note === 'summer ideas, revised' && l.createdAt === alphaBefore.createdAt && l.savedAt > alphaBefore.savedAt, { alphaBefore, l });
    const withNew = await shellCall(page, 'save', { name: 'Alpha notes', doc, tags: ['x'], note: '' });
    check('save: tags and a note given with the save replace the old ones', withNew.ok && (await keoCall(frame, 'world.list')).r.filter((w) => w.name === 'Alpha notes')[0].tags.join() === 'x');
    await keoCall(frame, 'world.meta', { name: 'Alpha notes', tags: ['Food', 'picnic'], note: 'summer ideas, revised' });

    // ---- 5. rename
    const re = await keoCall(frame, 'world.rename', { from: 'Alpha notes', to: 'Picnic' });
    l = (await keoCall(frame, 'world.list')).r;
    check('rename: the world has the new name, and the old one is gone', re.ok && re.r.name === 'Picnic' && names(l).includes('Picnic') && !names(l).includes('Alpha notes'), { re, names: names(l) });
    const ld = (await keoCall(frame, 'world.load', { name: 'Picnic' })).r;
    check('rename: the body is still there under the new name', ld && /Pineapple fritters/.test(ld.doc));
    r = await keoCall(frame, 'world.search', { query: 'pineapple' });
    check('rename: the search finds it under the new name and not the old (the odd-named world holds the same text)', r.ok && names(r.r.hits).join() === ['Picnic', odd].sort().join(), r);
    const clash = await keoCall(frame, 'world.rename', { from: 'Picnic', to: odd });
    check('rename: onto a name that is taken is refused, and both worlds are still there', !clash.ok && /already exists/.test(clash.e) && names((await keoCall(frame, 'world.list')).r).includes('Picnic') && names((await keoCall(frame, 'world.list')).r).includes(odd), clash);
    check('rename: a world that does not exist is refused', !(await keoCall(frame, 'world.rename', { from: 'Nope', to: 'X' })).ok);
    check('rename: to the same name changes nothing', (await keoCall(frame, 'world.rename', { from: 'Picnic', to: 'Picnic' })).ok);
    // 'Alpha notes' was the world saved last (its second save came after the odd-named one), so the last-world pointer must have moved
    const lastNow = await page.evaluate(() => window.keoWorlds.last().then((w) => w && w.name));
    check('rename: the world saved last follows its new name', lastNow === 'Picnic', lastNow);

    // ---- 6. duplicate
    const du = await keoCall(frame, 'world.duplicate', { from: 'Picnic', to: 'Picnic copy' });
    check('duplicate: a copy under a new name, with the same tags and note, and its own creation date', du.ok && du.r.name === 'Picnic copy' && du.r.tags.join() === 'Food,picnic' && du.r.note === 'summer ideas, revised', du);
    r = await keoCall(frame, 'world.search', { query: 'pineapple' });
    check('duplicate: both are found by the text inside', r.ok && names(r.r.hits).includes('Picnic') && names(r.r.hits).includes('Picnic copy'), r);
    check('duplicate: onto a taken name is refused', !(await keoCall(frame, 'world.duplicate', { from: 'Picnic', to: 'Picnic copy' })).ok);
    // the text is in the document twice (the markup and the data), so every occurrence is changed
    const changed = doc.split('Pineapple fritters for the picnic').join('Quince jam for the picnic');
    check('duplicate: (the changed document differs)', changed !== doc);
    await shellCall(page, 'save', { name: 'Picnic copy', doc: changed });
    r = await keoCall(frame, 'world.search', { query: 'pineapple' });
    const r2 = await keoCall(frame, 'world.search', { query: 'quince' });
    check('duplicate: changing the copy leaves the original alone, and the search follows each', names(r.r.hits).includes('Picnic') && !names(r.r.hits).includes('Picnic copy') && names(r2.r.hits).join() === 'Picnic copy', { r, r2 });

    // ---- 6b. templates: the preset a world was started from is kept with it, and only a known name is
    const withTpl = await shellCall(page, 'save', { name: 'Diary one', doc, template: 'diary' });
    l = (await keoCall(frame, 'world.list')).r.find((w) => w.name === 'Diary one');
    check('template: a world saved with a preset keeps its name', withTpl.ok && l && l.template === 'diary', { withTpl, l });
    await shellCall(page, 'save', { name: 'Diary one', doc });
    l = (await keoCall(frame, 'world.list')).r.find((w) => w.name === 'Diary one');
    check('template: saving again without one keeps it', l && l.template === 'diary', l);
    check('template: a world made without one has none', (await keoCall(frame, 'world.list')).r.find((w) => w.name === 'Picnic').template === null);
    const badTpl = await shellCall(page, 'save', { name: 'Odd', doc, template: 'not-a-template' });
    check('template: a name that is not a preset is refused, and nothing was saved', !badTpl.ok && /Not a template/.test(badTpl.e) && !(await keoCall(frame, 'world.has', { name: 'Odd' })).r, badTpl);
    const badGo = await keoCall(frame, 'world.go', { kind: 'blank', name: 'Odd two', template: '<script>' });
    check('template: world.go refuses a name that is not a preset, and the world keeps running', !badGo.ok && /Not a template/.test(badGo.e) && (await frame.evaluate(() => window.keo.init.startup.name)) === 'Alpha notes', badGo);
    const dupTpl = await keoCall(frame, 'world.duplicate', { from: 'Diary one', to: 'Diary two' });
    check('template: a copy of a world made from a preset has it too', dupTpl.ok && dupTpl.r.template === 'diary', dupTpl);
    await keoCall(frame, 'world.remove', { name: 'Diary one' }); await keoCall(frame, 'world.remove', { name: 'Diary two' });

    // ---- 7. concurrent changes are not lost
    const burst = await page.evaluate(async (d) => {
      const ps = []; for (let i = 0; i < 6; i++) ps.push(window.keoWorlds.save({ name: 'Burst ' + i, doc: d }).then(() => 'ok', (e) => e.message));
      ps.push(window.keoWorlds.setMeta({ name: 'Picnic', tags: ['burst'] }).then(() => 'ok', (e) => e.message));
      return Promise.all(ps);
    }, doc);
    l = (await keoCall(frame, 'world.list')).r;
    check('concurrency: six saves and a tag change at once all land', burst.every((x) => x === 'ok') && [0, 1, 2, 3, 4, 5].every((i) => names(l).includes('Burst ' + i)) && l.find((w) => w.name === 'Picnic').tags.join() === 'burst', { burst, names: names(l) });

    // ---- 8. what is on disk
    const disk = await page.evaluate(async () => {
      const db = await new Promise((res, rej) => { const q = indexedDB.open('keo-worlds'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const all = (s) => new Promise((res) => { const rq = db.transaction(s).objectStore(s).getAll(); rq.onsuccess = () => res(rq.result); });
      const bodies = await all('bodies'), texts = await all('texts'), index = await all('index'); const version = db.version; db.close();
      const hay = (recs) => recs.map((x) => String.fromCharCode.apply(null, new Uint8Array(x.ct).subarray(0, 4e6))).join('');
      return { version, nBodies: bodies.length, nTexts: texts.length, nIndex: index.length, sameIds: JSON.stringify(bodies.map((b) => b.id).sort()) === JSON.stringify(texts.map((t) => t.id).sort()),
        readable: /pineapple|picnic|Quince|burst|summer|Food/i.test(hay(texts) + hay(index) + JSON.stringify(index.map((x) => ({ did: x.did, iv: x.iv })))) };
    });
    check('disk: version 2, a text record for every body, one index', disk.version === 2 && disk.nBodies === disk.nTexts && disk.sameIds && disk.nIndex === 1, disk);
    check('disk: the text, the names, the tags and the notes are not readable without the key', disk.readable === false, disk);

    // ---- 9. one unreadable text record does not stop a search of the others
    const broke = await page.evaluate(async () => {
      const s = window.keoIdentity.sessionWorldKey(); const idx = await window.keoWorlds.list(); const victim = idx.find((w) => w.name === 'Picnic copy');
      const db = await new Promise((res, rej) => { const q = indexedDB.open('keo-worlds'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const recs = await new Promise((res) => { const rq = db.transaction('texts').objectStore('texts').getAll(); rq.onsuccess = () => res(rq.result); });
      // the copy's record is the one whose text mentions quince; flip a bit of every text record that decrypts to something with it
      let n = 0;
      for (const rec of recs) {
        try { const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: window.keoDid.unb64u(rec.iv), additionalData: new TextEncoder().encode('keo-worlds-text\n' + s.did + '\n' + rec.id) }, s.key, rec.ct);
          if (/Quince/.test(new TextDecoder().decode(pt))) { const ct = new Uint8Array(rec.ct); ct[0] ^= 1; await new Promise((res, rej) => { const t = db.transaction('texts', 'readwrite'); t.objectStore('texts').put(Object.assign({}, rec, { ct })); t.oncomplete = res; t.onerror = () => rej(t.error); }); n++; }
        } catch (e) {}
      }
      db.close(); return { n, victim: !!victim };
    });
    r = await keoCall(frame, 'world.search', { query: 'pineapple' });
    check('damage: with one text record changed, the others are still searched and the failure is counted', broke.n === 1 && r.ok && names(r.r.hits).includes('Picnic') && r.r.skipped === 1, { broke, names: r.r && names(r.r.hits), skipped: r.r && r.r.skipped });
    const rq = await keoCall(frame, 'world.search', { query: 'quince' });
    check('damage: the world whose text was changed is not found, and nothing else is', rq.ok && rq.r.hits.length === 0 && rq.r.skipped === 1, rq);

    // ---- 10. delete
    const before = (await keoCall(frame, 'world.list')).r.length;
    await keoCall(frame, 'world.remove', { name: 'Picnic copy' });
    await keoCall(frame, 'world.remove', { name: 'Burst 0' });
    l = (await keoCall(frame, 'world.list')).r;
    const after = await page.evaluate(async () => { const db = await new Promise((res) => { const q = indexedDB.open('keo-worlds'); q.onsuccess = () => res(q.result); }); const c = (s) => new Promise((res) => { const rq = db.transaction(s).objectStore(s).count(); rq.onsuccess = () => res(rq.result); }); const o = { b: await c('bodies'), t: await c('texts') }; db.close(); return o; });
    check('delete: the world is gone from the list, and its body and text are gone from the disk', l.length === before - 2 && !names(l).includes('Picnic copy') && after.b === l.length && after.t === l.length, { before, after, n: l.length });
    r = await keoCall(frame, 'world.search', { query: 'quince' });
    check('delete: a deleted world is no longer found', r.ok && r.r.hits.length === 0, r);

    // ---- 11. a database made by the version before this one (no texts store, no tags, no creation date)
    const upgraded = await page.evaluate(async () => {
      const s = window.keoIdentity.sessionWorldKey(), kd = window.keoDid, enc = new TextEncoder();
      await new Promise((res, rej) => { const q = indexedDB.deleteDatabase('keo-worlds'); q.onsuccess = res; q.onerror = () => rej(q.error); q.onblocked = () => rej(new Error('blocked')); });
      const db = await new Promise((res, rej) => { const q = indexedDB.open('keo-worlds', 1); q.onupgradeneeded = () => { q.result.createObjectStore('index', { keyPath: 'did' }); q.result.createObjectStore('bodies', { keyPath: 'id' }).createIndex('did', 'did'); }; q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const seal = async (plain, aad) => { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, s.key, enc.encode(plain)); return { iv: kd.b64u(iv), ct: new Uint8Array(ct) }; };
      const id = kd.b64u(crypto.getRandomValues(new Uint8Array(16)));
      const docText = '<html><body><script type="text/x-lively-world" id="w">' + JSON.stringify({ id: '0', registry: { '3': { storedString: 'Legacyword from the old version' } } }) + '</script></body></html>';
      const body = await seal(docText, 'keo-worlds-body\n' + s.did + '\n' + id);
      const idx = await seal(JSON.stringify({ worlds: { 'Old world': { id, savedAt: '2026-01-02T03:04:05.000Z', bytes: docText.length } }, last: 'Old world' }), 'keo-worlds-index\n' + s.did);
      await new Promise((res, rej) => { const t = db.transaction(['bodies', 'index'], 'readwrite'); t.objectStore('bodies').put({ id, did: s.did, iv: body.iv, ct: body.ct }); t.objectStore('index').put({ did: s.did, iv: idx.iv, ct: idx.ct }); t.oncomplete = res; t.onerror = () => rej(t.error); });
      db.close();
      const list = await window.keoWorlds.list();
      const found = await window.keoWorlds.search({ query: 'legacyword' });
      const again = await window.keoWorlds.search({ query: 'legacyword' });
      const v2 = await new Promise((res) => { const q = indexedDB.open('keo-worlds'); q.onsuccess = () => { const o = { version: q.result.version, stores: [...q.result.objectStoreNames].sort() }; q.result.close(); res(o); }; });
      const loaded = await window.keoWorlds.load({ name: 'Old world' });
      return { list, found, again, v2, loaded: !!loaded && /Legacyword/.test(loaded.doc) };
    });
    check('upgrade: the old database opens as version 2 and keeps its world', upgraded.v2.version === 2 && upgraded.v2.stores.join() === 'bodies,index,texts' && upgraded.loaded, upgraded);
    check('upgrade: an old world shows with no tags, no note, and its saved date as its creation date', upgraded.list.length === 1 && upgraded.list[0].name === 'Old world' && upgraded.list[0].tags.length === 0 && upgraded.list[0].note === '' && upgraded.list[0].createdAt === '2026-01-02T03:04:05.000Z' && upgraded.list[0].last === true, upgraded.list);
    check('upgrade: the first search makes the text of the old world and finds it', upgraded.found.hits.length === 1 && upgraded.found.hits[0].name === 'Old world' && upgraded.found.skipped === 0 && upgraded.again.hits.length === 1, upgraded.found);

    check('no errors came from the shell files', errors.length === 0, errors);
  } catch (e) {
    check('the run finished', false, e.stack || String(e));
  } finally {
    await ctx.close().catch(() => {});
  }
  console.log(failed ? failed + ' check(s) FAILED' : 'all checks passed');
  process.exit(failed ? 1 : 0);
})();
