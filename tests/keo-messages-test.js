// End-to-end test of Messages inside keo (kernel lively.identity.DMChat in local mode, shell/keo-dm.js) and of the Call button.
// Usage: node keo-messages-test.js <repo root> <extension folder> <work dir>
// Two headed browsers (two profiles = two devices on one machine), each with the package loaded, `localhost` unresolvable, its own
// virtual authenticator and the browser's fake camera. Each makes an identity and lands on its home page; the connection is made through
// the world's bridge (as keo-p2p-test.js does). Messages is then reached the way a person reaches it: the menu bar entry, a click
// on the inbox row, REAL typing in the chat window and a real Enter, a real click on the Call button.
// NOT covered: two real machines, a real authenticator, how the windows look (look at a screenshot: set SHOT_DIR), a message that
// arrives while the world is restarting (the shell keeps it until the world has saved it: checked here through dm.take only),
// two identities on one device (the thread list is filtered by identity, which is not tested with a second identity).
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { befriend } = require('./friends-helper.js');
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'cgjphijackijgcjkfdfieihkbfooigjp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 900) : '')); }
const errors = [], ctxs = [];

const worldFrame = (page) => page.frames().find((f) => /world\.html$/.test(f.url()));
async function waitForWorld(page, kind) {
  for (let i = 0; i < 200; i++) {
    const f = worldFrame(page);
    if (f) { try { if (await f.evaluate((k) => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind === k), kind)) { await sleep(2500); return f; } } catch (e) {} }
    await sleep(300);
  }
  throw new Error('the world did not start as ' + kind);
}
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 20000)) { const v = await fn().catch(() => null); if (v) return v; await sleep(150); } return null; }
const call = (frame, op, args) => frame.evaluate(([o, a]) => window.keo.call(o, a, 60000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [op, args || {}]);
const p2pEvents = (P) => P.frame.evaluate(() => window.__p2p.slice());
const findP2p = (P, type, pred, ms) => waitFor(async () => (await p2pEvents(P)).find((e) => e.type === type && (!pred || pred(e))), ms);

async function device(label, name) {
  const y4m = path.join(WORK, 'fake-camera.y4m');
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-msg-' + name), {
    headless: false, viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`] });
  ctxs.push(ctx);
  await ctx.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:' || !navigator.mediaDevices) return;
    window.__gum = 0;
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { window.__gum++; return orig(c); };
  });
  await sleep(2000);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('pageerror', (e) => errors.push(name + ' PAGEERROR ' + e.message.slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure|ERR_FILE_NOT_FOUND/.test(m.text())) errors.push(name + ' console: ' + m.text().slice(0, 200)); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  await page.goto(`chrome-extension://${ID}/start.html`);
  let frame = await waitForWorld(page, 'gate');
  const created = await page.evaluate((l) => window.keoIdentity.create({ label: l }), label);
  await frame.evaluate(() => window.keo.call('world.go', { kind: 'enter' }, 60000)).catch(() => {});
  frame = await waitForWorld(page, 'homestar');
  await frame.evaluate(() => { window.__p2p = []; window.keo.on('p2p', (e) => window.__p2p.push(e)); });
  return { label, name, ctx, page, frame, did: created.did };
}
async function connectOnly(A, B) {
  const inv = await call(A.frame, 'p2p.offer', { name: A.label });
  const ans = await call(B.frame, 'p2p.answer', { code: inv.r.code, name: B.label });
  await call(A.frame, 'p2p.finish', { id: inv.r.id, code: ans.r.code });
  const ra = await findP2p(A, 'state', (e) => e.id === inv.r.id && e.state === 'ready'), rb = await findP2p(B, 'state', (e) => e.id === ans.r.id && e.state === 'ready');
  if (!ra || !rb) throw new Error('the devices did not connect');
  return { a: inv.r.id, b: ans.r.id };
}
async function connect(A, B) {
  const k = await connectOnly(A, B);
  await befriend(A, B, k);            // messages, calls and file offers are for friends: the first time through the shell's dialogs, afterwards the books remember
  return k;
}

// ---- the world's own UI, from outside
const menuLabels = (P) => P.frame.evaluate(() => { const bar = $world.get(/MenuBar/), entry = $world.get('IdentityMenuBarEntry') || bar.submorphs.filter((m) => m.name === 'IdentityMenuBarEntry')[0]; return entry.morphMenuItems().map((i) => i[0]); });
const menuRun = (P, re) => P.frame.evaluate((src) => { const bar = $world.get(/MenuBar/), entry = $world.get('IdentityMenuBarEntry') || bar.submorphs.filter((m) => m.name === 'IdentityMenuBarEntry')[0]; const item = entry.morphMenuItems().filter((i) => new RegExp(src).test(i[0]))[0]; if (!item) return false; item[1](); return true; }, re.source);
const chat = (P, did, fn, arg) => P.frame.evaluate(new Function('a', 'const w = lively.identity.DMChat._windows[a.did]; if (!w || !w.world()) return null; return (' + fn + ')(w, a.arg);'), { did, arg });
const chatText = (P, did) => chat(P, did, (w) => w.get('MessageList').renderContext().shapeNode.innerText);
const caption = (P, did) => chat(P, did, (w) => w.get('EncryptedCaption').textString);
// the middle of a named morph in a chat window, and whether something else is drawn there
const whereIn = (P, did, name) => chat(P, did, (w, n) => { const m = w.get(n); if (!m) return null; const node = m.renderContext().shapeNode, b = node.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2, top = document.elementFromPoint(x, y); return { x, y, covered: !(top && (node === top || node.contains(top) || top.contains(node))) }; }, name);
async function clickIn(P, did, name) { const r = await whereIn(P, did, name); if (!r) throw new Error('no morph named ' + name); if (r.covered) throw new Error(name + ' is covered'); await P.page.mouse.click(r.x, r.y); }
async function typeIn(P, did, text) { await clickIn(P, did, 'InputField'); await P.page.keyboard.type(text, { delay: 15 }); await P.page.keyboard.press('Enter'); }
// the conversation with `b`, as the chat window reads it (from the shell's encrypted history; `a` is only for the reader's eyes)
const rows = (P, a, b) => P.frame.evaluate((y) => new Promise((res) => lively.identity.DMChat.listLocalMessages(y, (e, r) => res(r || []))), b);
// everything the shell has written to its history store, as it is on disk
const dump = (P) => P.page.evaluate(() => new Promise((res, rej) => { const q = indexedDB.open('keo-chat'); q.onerror = () => rej(q.error); q.onsuccess = () => { const db = q.result, out = {}; let n = 0; const t = db.transaction(['index', 'bodies'], 'readonly'); ['index', 'bodies'].forEach((st) => { const r = t.objectStore(st).getAll(); r.onsuccess = () => { out[st] = r.result.map((x) => ({ did: x.did, id: x.id, iv: x.iv, ct: Array.from(x.ct) })); if (++n === 2) { db.close(); res(out); } }; }); }; }));
const inbox = (P) => P.frame.evaluate(() => { const w = lively.identity.DMChat._inboxWindow; if (!w || !w.world()) return null; return w.get('ThreadList').renderContext().shapeNode.innerText; });
const panel = (P) => P.page.evaluate(() => { const r = document.getElementById('keo-call'); return r ? { hidden: r.hidden, status: r.querySelector('.status').textContent, acts: Array.from(r.querySelectorAll('button[data-act]')).map((b) => b.getAttribute('data-act')) } : null; });
const shot = (page, n) => process.env.SHOT_DIR ? page.screenshot({ path: path.join(process.env.SHOT_DIR, n + '.png') }) : null;
const send = (P, id, m) => P.page.evaluate(([i, x]) => window.keoP2p.handle(i).send(x), [id, m]);

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const hard = setTimeout(async () => { console.log('HARD TIMEOUT'); for (const c of ctxs) await c.close().catch(() => {}); process.exit(3); }, 420000);
  const A = await device('Maya', 'a'), B = await device('Jun', 'b');
  try {
    // ---- 0. the menu, before and after a connection
    check('the menu bar offers Messages to a signed-in local identity', (await menuLabels(A)).some((l) => /^Messages/.test(l)), await menuLabels(A));
    const k = await connectOnly(A, B);
    await sleep(800);
    // ---- 0b. connected is not enough: until the two are friends the screens say so and nothing is sent or rung
    await A.page.bringToFront();
    await menuRun(A, /^Messages/);
    const notYet = await waitFor(async () => { const x = await inbox(A); return x && /Jun/.test(x) ? x : null; }, 15000);
    check('before they are friends the inbox lists the connected device as "Connected, not friends yet."', !!notYet && /Connected, not friends yet/.test(notYet) && !/Say hello/.test(notYet), notYet);
    await A.frame.evaluate((d) => lively.identity.DMChat.openLocal('Jun', d), B.did);
    check('the chat window says "Connected, not friends"', (await waitFor(async () => (await caption(A, B.did)) === 'Connected, not friends' ? true : null, 8000)) === true, await caption(A, B.did));
    await shot(A.page, 'msg-0-not-friends');
    await typeIn(A, B.did, 'too early');
    await sleep(1200);
    check('a message typed to a non-friend is not sent, and does not appear in the thread', !/too early/.test((await chatText(A, B.did)) || '') && (await call(B.frame, 'dm.take')).r.length === 0);
    check('the refused draft is put back in the box, not lost', (await chat(A, B.did, (w) => w.get('InputField').textString)) === 'too early');
    await chat(A, B.did, (w) => { w.get('InputField').textString = ''; return true; });
    await clickIn(A, B.did, 'CallButton');
    await sleep(1000);
    check('the Call button asks for nothing from a non-friend (no prompt)', ((await panel(A)) || { hidden: true }).hidden === true);
    await befriend(A, B, k);
    check('once they are friends the window says so', (await waitFor(async () => (await caption(A, B.did)) === 'Connected directly' ? true : null, 8000)) === true, await caption(A, B.did));
    check('an open menu entry opens the inbox, which lists the connected device even though no message was sent yet', await (async () => {
      await A.page.bringToFront();
      await menuRun(A, /^Messages/);
      const t = await waitFor(async () => { const x = await inbox(A); return x && /Jun/.test(x) ? x : null; }, 15000);
      return !!t && /Connected\. Say hello/.test(t);
    })(), await inbox(A));
    await shot(A.page, 'msg-1-inbox');

    // ---- 1. open the chat by clicking the inbox row (a real click)
    const rowPos = await A.frame.evaluate(() => { const list = lively.identity.DMChat._inboxWindow.get('ThreadList'); const row = list.submorphs.filter((m) => m._peerDid)[0]; if (!row) return null; const b = row.renderContext().shapeNode.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, did: row._peerDid }; });
    check('the inbox row is for the peer\'s DID', !!rowPos && rowPos.did === B.did, rowPos);
    await A.page.mouse.click(rowPos.x, rowPos.y);
    check('clicking the row opens a chat window for that device', !!(await waitFor(() => chat(A, B.did, () => true), 10000)));
    check('the window says the connection is up', (await waitFor(async () => (await caption(A, B.did)) === 'Connected directly' ? true : null, 8000)) === true, await caption(A, B.did));
    check('it has a Call button and a send box, none covered by anything else', (await whereIn(A, B.did, 'CallButton') || {}).covered === false && (await whereIn(A, B.did, 'InputField') || {}).covered === false);
    await shot(A.page, 'msg-2-chat');

    // ---- 2. a message by real typing: it appears for both, B's window opens by itself
    await typeIn(A, B.did, 'hello Jun');
    check('A sees its own message in the thread', !!(await waitFor(async () => /hello Jun/.test((await chatText(A, B.did)) || '') ? true : null, 8000)));
    const gotB = await waitFor(async () => /hello Jun/.test((await chatText(B, A.did)) || '') ? true : null, 15000);
    check('B\'s chat window opened by itself and shows the message', !!gotB, await chatText(B, A.did));
    check('B\'s window is labelled with the name A chose to show, and shows A\'s DID in its picture seed', (await chat(B, A.did, (w) => w._peerHandle)) === 'Maya' && (await chat(B, A.did, (w) => w._local)) === true);
    check('the shell holds nothing back once the world has saved the message', (await call(B.frame, 'dm.take')).r.length === 0);
    const rA = await rows(A.frame ? A : A, A.did, B.did), rB = await rows(B, B.did, A.did);
    check('both sides saved it, as out on A and in on B, with the peer\'s DID', rA.length === 1 && rA[0].direction === 'out' && rB.length === 1 && rB[0].direction === 'in' && rB[0].text === 'hello Jun', { rA, rB });
    const thA = (await call(A.frame, 'chat.threads')).r;
    check('the conversation list names the peer by its DID, with the label it chose and the last message', thA.length === 1 && thA[0].peerDid === B.did && thA[0].label === 'Jun' && thA[0].lastText === 'hello Jun', thA);

    // ---- 1b. the history is encrypted on disk, and tampering is noticed
    const disk = await dump(A), hay = JSON.stringify(disk);
    check('on disk there is one encrypted index for this identity and one body for the conversation', disk.index.length === 1 && disk.index[0].did === A.did && disk.bodies.length === 1 && disk.bodies[0].did === A.did, { i: disk.index.length, b: disk.bodies.length });
    check('neither the text nor the peer DID can be found in what is stored', !hay.includes('hello Jun') && !hay.includes(B.did) && !hay.includes(B.did.slice(8, 24)), hay.slice(0, 120));
    check('the world keeps no copy of it in its own storage', await A.frame.evaluate(() => new Promise((res) => lively.identity.DMChat.openDb((e, db) => { if (e) return res(true); const r = db.transaction('messages', 'readonly').objectStore('messages').count(); r.onsuccess = () => res(r.result === 0); }))));
    await A.page.evaluate(() => new Promise((res) => { const q = indexedDB.open('keo-chat'); q.onsuccess = () => { const db = q.result, t = db.transaction('index', 'readwrite'), st = t.objectStore('index'), r = st.getAll(); r.onsuccess = () => { const x = r.result[0]; window.__orig = new Uint8Array(x.ct); x.ct[0] ^= 1; st.put(x); }; t.oncomplete = () => { db.close(); res(true); }; }; }));
    const tam = await call(A.frame, 'chat.threads');
    check('a changed record is refused, not read', tam.ok === false && /could not be decrypted/.test(tam.e), tam);
    await A.page.evaluate(() => new Promise((res) => { const q = indexedDB.open('keo-chat'); q.onsuccess = () => { const db = q.result, t = db.transaction('index', 'readwrite'), st = t.objectStore('index'), r = st.getAll(); r.onsuccess = () => { const x = r.result[0]; x.ct = new Uint8Array(window.__orig); st.put(x); }; t.oncomplete = () => { db.close(); res(true); }; }; }));
    check('and the original reads again', (await call(A.frame, 'chat.threads')).ok === true);
    const bad = [['not a did', 'in', 'x'], [B.did, 'sideways', 'x'], [B.did, 'in', 'y'.repeat(8001)], [B.did, 'in', '']].map(([p, d, t]) => call(A.frame, 'chat.append', { peerDid: p, label: 'x', k: 'k1', dir: d, text: t, at: new Date().toISOString() }));
    const badRes = await Promise.all(bad);
    check('the world cannot write a malformed record (bad DID, bad direction, too long, empty)', badRes.every((r) => r.ok === false), badRes);
    await shot(B.page, 'msg-3-received');

    // B answers (B's window is in the page B shows)
    await B.page.bringToFront();
    await typeIn(B, A.did, 'hi Maya, I hear you');
    const gotReply = !!(await waitFor(async () => /hi Maya, I hear you/.test((await chatText(A, B.did)) || '') ? true : null, 15000));
    // (if it fails, say which step: is the message still in A's shell, was it saved, is A's window the one the pull would find?)
    check('A receives the reply in its open window', gotReply, gotReply ? undefined : {
      windowText: await chatText(A, B.did), shellStillHolds: await A.page.evaluate(() => window.keoDm.take().map((m) => m.text)), saved: (await rows(A, A.did, B.did)).map((r) => r.text),
      windows: await A.frame.evaluate(() => Object.keys(lively.identity.DMChat._windows).map((k) => [k.slice(-6), !!(lively.identity.DMChat._windows[k].world())])),
      pulling: await A.frame.evaluate(() => [lively.identity.DMChat._pulling, lively.identity.DMChat._again]), bState: (await p2pEvents(B)).filter((e) => e.type === 'state').map((e) => e.state + ':' + e.friend).slice(-4) });
    // several quickly: all arrive, once each, in order
    await A.page.bringToFront();
    for (const t of ['one', 'two', 'three']) { await typeIn(A, B.did, t); }
    check('three quick messages arrive once each and in order', !!(await waitFor(async () => { const t = (await chatText(B, A.did)) || ''; const i = t.indexOf('one'), j = t.indexOf('two'), l = t.indexOf('three'); return i > 0 && j > i && l > j ? true : null; }, 15000)));
    const afterBurst = await rows(B, B.did, A.did);
    check('and are saved once each', afterBurst.filter((r) => ['one', 'two', 'three'].includes(r.text)).length === 3 && new Set(afterBurst.map((r) => r.msgId)).size === afterBurst.length, afterBurst.map((r) => r.text));

    // ---- 3. the thread survives closing the window
    await A.frame.evaluate((did) => { lively.identity.DMChat._windows[did].getWindow().remove(); }, B.did);
    await A.frame.evaluate((did) => { lively.identity.DMChat.openLocal('Jun', did); }, B.did);
    const hist = await waitFor(async () => { const t = (await chatText(A, B.did)) || ''; return /hello Jun/.test(t) && /three/.test(t) ? t : null; }, 10000);
    check('reopening the chat shows the whole history', !!hist, await chatText(A, B.did));
    check('each message appears once (read from the store and handed over, never twice)', !!hist && (hist.match(/hello Jun/g) || []).length === 1 && (hist.match(/hi Maya/g) || []).length === 1, hist);

    // ---- 4. no connection, no message
    await call(B.frame, 'p2p.close', { id: k.b });
    check('the window notices the connection is gone', !!(await waitFor(async () => (await caption(A, B.did)) === 'Not connected' ? true : null, 10000)), await caption(A, B.did));
    const before = (await rows(A, A.did, B.did)).length;
    await typeIn(A, B.did, 'into the void');
    await sleep(1200);
    const textAfter = (await chatText(A, B.did)) || '';
    check('a message cannot be sent without a connection: it is not shown as sent and not saved', !/into the void\n/.test(textAfter.replace(/\s+$/, '\n')) && (await rows(A, A.did, B.did)).length === before, textAfter);
    check('and the text is put back in the box', (await chat(A, B.did, (w) => w.get('InputField').textString)) === 'into the void');
    await chat(A, B.did, (w) => { w.get('InputField').textString = ''; });

    // ---- 5. a new connection to the same device: the window follows, messages flow again
    const k2 = await connect(A, B);
    check('after reconnecting the window says so', !!(await waitFor(async () => (await caption(A, B.did)) === 'Connected directly' ? true : null, 10000)));
    await typeIn(A, B.did, 'back again');
    check('and messages go through', !!(await waitFor(async () => /back again/.test((await chatText(B, A.did)) || '') ? true : null, 15000)));

    // ---- 6. a hostile peer (this script sends raw messages from the shell page of B)
    const outRows = (await rows(A, A.did, B.did)).filter((r) => r.direction === 'out');
    const mine = outRows[0], mineMid = mine.msgId.replace(/^out:/, '');
    await send(B, k2.b, { t: 'dm.text', mid: mineMid, text: 'I am overwriting your row' });
    await waitFor(async () => /overwriting your row/.test((await chatText(A, B.did)) || '') ? true : null, 10000);
    const rowsNow = await rows(A, A.did, B.did);
    const kept = rowsNow.find((r) => r.msgId === mine.msgId);
    check('a peer that reuses the id of a message A sent cannot change that message', !!kept && kept.text === mine.text && kept.direction === 'out', kept);
    check('its text is just another incoming message', rowsNow.some((r) => r.direction === 'in' && r.text === 'I am overwriting your row'));
    await send(B, k2.b, { t: 'dm.text', mid: 'XXXXXXXXXXXX', text: 'x'.repeat(8001) });
    const c1 = await findP2p(A, 'state', (e) => e.id === k2.a && e.state === 'closed', 10000);
    check('a message over the length limit closes the connection', !!c1 && /bad message/.test(c1.why || ''), c1);
    const k3 = await connect(A, B);
    await send(B, k3.b, { t: 'dm.text', mid: '!!', text: 'bad id' });
    const c2 = await findP2p(A, 'state', (e) => e.id === k3.a && e.state === 'closed', 10000);
    check('a message with a malformed id closes it too', !!c2 && /bad message/.test(c2.why || ''), c2);
    const k4 = await connect(A, B);
    await send(B, k4.b, { t: 'dm.bogus', mid: 'YYYYYYYYYYYY', text: 'hi' });
    const c3 = await findP2p(A, 'state', (e) => e.id === k4.a && e.state === 'closed', 10000);
    check('an unknown dm message type closes it', !!c3 && /bad message/.test(c3.why || ''), c3);

    // ---- 7. the Call button asks, the shell prompts, nothing starts without a click there
    const k5 = await connect(A, B);
    await waitFor(async () => (await caption(A, B.did)) === 'Connected directly' ? true : null, 10000);
    await A.page.bringToFront();
    const g0 = await A.page.evaluate(() => window.__gum);
    await clickIn(A, B.did, 'CallButton');
    const pr = await waitFor(async () => { const p = await panel(A); return p && !p.hidden ? p : null; }, 10000);
    check('the Call button makes the shell put its prompt up: "Call Jun?"', !!pr && /^Call Jun\?/.test(pr.status), pr);
    await sleep(2000);
    check('and nothing is captured until the person clicks in that prompt', (await A.page.evaluate(() => window.__gum)) === g0);
    await A.page.click('#keo-call button[data-act="cancel"]');
    check('Cancel there ends it', !!(await waitFor(async () => { const p = await panel(A); return p && p.hidden ? true : null; }, 8000)));
    // the phone button asks for an audio call: the prompt has no video choice (after the shell's pause for a dismissed prompt)
    await sleep(10500);
    check('there is a separate audio call button next to the video one, not covered', (await whereIn(A, B.did, 'AudioCallButton') || {}).covered === false);
    await clickIn(A, B.did, 'AudioCallButton');
    const prA = await waitFor(async () => { const p = await panel(A); return p && !p.hidden ? p : null; }, 10000);
    check('the phone button makes the shell put up an audio-only prompt: "Audio call Jun?", no video button', !!prA && /^Audio call Jun\?/.test(prA.status) && prA.acts.join() === 'go-audio,cancel', prA);
    await sleep(1500);
    check('and nothing is captured until the person clicks in it', (await A.page.evaluate(() => window.__gum)) === g0);
    await A.page.click('#keo-call button[data-act="cancel"]');
    await waitFor(async () => { const p = await panel(A); return p && p.hidden ? true : null; }, 8000);
    // the presence panel's camera button asks for a call too
    await sleep(10500);
    const cam = await A.frame.evaluate(() => { const p = lively.identity.AmbientPresencePanel._panel; if (!p) return null; const n = p._camBtn.renderContext().shapeNode, b = n.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2, top = document.elementFromPoint(x, y); return { x, y, covered: !(top && (n === top || n.contains(top) || top.contains(n))), icon: p._camBtn.textString }; });
    check('the presence panel has a camera button that is not covered', !!cam && cam.covered === false, cam);
    await A.page.mouse.click(cam.x, cam.y);
    const pr2 = await waitFor(async () => { const p = await panel(A); return p && !p.hidden ? p : null; }, 10000);
    check('with one connected device it puts the call prompt up: "Call Jun?"', !!pr2 && /^Call Jun?/.test(pr2.status), pr2);
    await A.page.click('#keo-call button[data-act="cancel"]');
    await waitFor(async () => { const p = await panel(A); return p && p.hidden ? true : null; }, 8000);
    await call(A.frame, 'p2p.close', { id: k5.a });
    await sleep(500);
    await clickIn(A, B.did, 'CallButton');
    await sleep(800);
    check('without a connection the Call button asks for nothing (no prompt)', ((await panel(A)) || { hidden: true }).hidden === true);

    // ---- 8. the Friends window (menu: Friends ...): the book, this identity's own words, and Remove with the shell's question
    const labels = await menuLabels(A);
    check('the menu offers "Friends ..." next to "Connect a device ..."', labels.some((l) => /^Friends/.test(l)), labels);
    await A.page.bringToFront();
    await menuRun(A, /^Friends/);
    const win = () => A.frame.evaluate(() => {
      const w = $world.submorphs.filter((m) => m.name === 'IdentityFriendsDialog')[0];
      if (!w) return null;
      const content = w.get('friendsContent'), pick = (n) => content.submorphs.filter((m) => m.name === n);
      return { words: (pick('myWords')[0] || {}).textString, names: pick('friendName').map((m) => m.textString), subs: pick('friendDid').map((m) => m.textString), empty: !!pick('emptyText').length,
        avatars: pick('friendAvatar').length, status: (pick('statusText')[0] || {}).textString };
    });
    const myWords = await A.page.evaluate(() => window.keoFriend.myWords());
    const f1 = await waitFor(async () => { const x = await win(); return x && x.names.length && x.words && x.words !== '…' ? x : null; }, 15000);
    check('the Friends window lists the friend by name with a picture, and says it is not connected right now', !!f1 && f1.names.join() === 'Jun' && f1.avatars === 1 && /not connected/.test(f1.subs[0]) && f1.subs[0].indexOf(await A.frame.evaluate((d) => lively.identity.localIdentity.shortDid(d), B.did)) === 0, f1);
    check('it shows this identity\'s own eight words (never the friend\'s)', !!f1 && f1.words === myWords.join(' '), f1);
    await shot(A.page, 'msg-8-friends');
    const rm = (name) => A.frame.evaluate((n) => { const w = $world.submorphs.filter((m) => m.name === 'IdentityFriendsDialog')[0]; const m = w.get('friendsContent').submorphs.filter((x) => x.name === n)[0]; if (!m) return null; const node = m.renderContext().shapeNode, b = node.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2, top = document.elementFromPoint(x, y); return { x, y, covered: !(top && (node === top || node.contains(top) || top.contains(node))) }; }, name);
    const rb = await rm('removeBtn');
    check('Remove is on screen and not covered', !!rb && rb.covered === false, rb);
    await A.page.mouse.click(rb.x, rb.y);
    const asked = await waitFor(async () => A.page.evaluate(() => { const r = document.getElementById('keo-confirm'); return r && !r.hidden ? r.textContent : null; }), 8000);
    check('Remove makes the SHELL ask, naming the device', !!asked && /Remove this friend\?/.test(asked) && /Jun/.test(asked), asked);
    check('and nothing is removed until the person answers', (await call(A.frame, 'friend.list')).r.length === 1);
    await A.page.click('#keo-confirm button[data-ans="yes"]');
    const f2 = await waitFor(async () => { const x = await win(); return x && x.empty ? x : null; }, 10000);
    check('after a real yes the window shows no friends and the book is empty', !!f2 && (await call(A.frame, 'friend.list')).r.length === 0, f2);
  } catch (e) {
    failed++; console.log('FAIL test crashed: ' + (e && e.stack || e));
  }
  // The landing page's two known ones, as in the other tests; and the red status line the world also logs when the checks above send
  // a message or ask for a call with no connection, which is the answer being tested.
  try {
    await call(A.frame, 'p2p.close', { id: 'none' });
    await A.page.evaluate((d) => window.keoChatLog.purge(d), A.did);
    const gone = await dump(A);
    check('removing an identity removes its conversations (purge leaves no record)', gone.index.length === 0 && gone.bodies.length === 0 && (await call(A.frame, 'chat.threads')).r.length === 0, gone);
  } catch (e) { failed++; console.log('FAIL purge: ' + e.message); }
  const mine = errors.filter((e) => !/youtube\.com|Geolocation access|Not connected to this device|You can only (message|call) a friend/.test(e));
  check('no page errors or console errors (other than the landing page\'s two known ones)', mine.length === 0, mine.slice(0, 5));
  for (const c of ctxs) await c.close().catch(() => {});
  clearTimeout(hard);
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
