// End-to-end test of the "Connect a device" dialog (kernel lively.identity.PeerDialog) in the built keo extension.
// Usage: node keo-peer-dialog-test.js <repo root> <extension folder> <work dir>
// Two headed browsers (two profiles = two devices on one machine), each with the package loaded, `localhost` unresolvable and
// its own CDP virtual authenticator. Each makes an identity and lands on its home page; the dialog is opened from the menu bar
// entry, and everything is done by REAL mouse clicks on its buttons (so a morph drawn over a button would fail), the real
// file chooser and the real download. The two codes are carried between the browsers by this script, standing in for a paste.
// NOT covered: two real machines, a real authenticator, a real clipboard paste (the clipboard cannot be read from an extension
// page without a permission prompt only a person can answer: what the world asks the browser to copy is checked instead, and
// the text is put into the paste boxes by the browser's own text insertion), a screen reader or a phone.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 700) : '')); }
const errors = [], ctxs = [];
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

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

// ---- the dialog, from outside
const dlg = (frame, fn, arg) => frame.evaluate(new Function('arg', 'const d = window.__dlg; if (!d || !d.world()) return null; return (' + fn + ')(d, arg);'), arg);
const state = (frame) => dlg(frame, (d) => { const names = []; (function w(m) { if (m.name) names.push(m.name); (m.submorphs || []).forEach(w); })(d); return { phase: d._p.phase, names: names, status: (d.get('statusText') || {}).textString || '', rows: d._rows.map((r) => r.dir + ':' + r.state) }; });
const phase = async (frame) => ((await state(frame)) || {}).phase;
const has = async (frame, name) => ((await state(frame)) || { names: [] }).names.includes(name);
const textOf = (frame, name) => dlg(frame, (d, n) => { let out = null; (function w(m) { if (m.name === n && out === null) out = String(m.textString); (m.submorphs || []).forEach(w); })(d); return out; }, name);
// where a named morph is on the page, and what the browser puts at its middle (a morph drawn over a button would show here)
const where = (frame, name, nth) => dlg(frame, (d, a) => { const found = []; (function w(m) { if (m.name === a.n) found.push(m); (m.submorphs || []).forEach(w); })(d); const m = found[a.k]; if (!m) return null; const node = m.renderContext().shapeNode, b = node.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2, top = document.elementFromPoint(x, y); return { x, y, w: b.width, h: b.height, covered: !(top && (node === top || node.contains(top) || top.contains(node))) }; }, { n: name, k: nth || 0 });
async function click(page, frame, name, nth) {
  const r = await where(frame, name, nth);
  if (!r) throw new Error('no morph named ' + name);
  if (r.covered) throw new Error(name + ' is covered by something else');
  await page.mouse.click(r.x, r.y);
}
// A REAL paste: the text is on the system clipboard (put there by the other dialog's own Copy button), the box is clicked into and
// Ctrl+V is pressed. Returns what the dialog then holds.
const pasteInto = async (page, frame, name) => {
  await click(page, frame, name);
  await page.keyboard.press('Control+V');
  await sleep(400);
  return textOf(frame, name);
};
const code = (frame) => dlg(frame, (d) => d._p.code);
const shot = (page, n) => process.env.SHOT_DIR ? page.screenshot({ path: path.join(process.env.SHOT_DIR, n + '.png') }) : null;

async function device(label, name) {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-dlg-' + name), {
    headless: false, viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  ctxs.push(ctx);
  await sleep(2000);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('pageerror', (e) => errors.push(name + ' PAGEERROR ' + e.message.slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure|ERR_FILE_NOT_FOUND/.test(m.text())) errors.push(name + ' console: ' + m.text().slice(0, 200)); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  // a new identity lands on its home page, where the menu bar shows it
  await page.goto(`chrome-extension://${ID}/start.html`);
  let frame = await waitForWorld(page, 'gate');
  const created = await page.evaluate((l) => window.keoIdentity.create({ label: l }), label);
  await frame.evaluate(() => window.keo.call('world.go', { kind: 'enter' }, 60000)).catch(() => {});
  frame = await waitForWorld(page, 'homestar');
  return { label, name, ctx, page, frame, did: created.did, dir: path.join(WORK, 'dl-' + name) };
}
// the menu bar's own entry, as a person would reach it
const menuItems = (frame) => frame.evaluate(() => { const bar = $world.get(/MenuBar/), entry = $world.get('IdentityMenuBarEntry') || (bar && bar.submorphs.filter((m) => m.name === 'IdentityMenuBarEntry')[0]); return entry ? entry.morphMenuItems().map((i) => i[0]) : null; });
const openFromMenu = (frame) => frame.evaluate(() => { const bar = $world.get(/MenuBar/), entry = $world.get('IdentityMenuBarEntry') || bar.submorphs.filter((m) => m.name === 'IdentityMenuBarEntry')[0]; const item = entry.morphMenuItems().filter((i) => /Connect a device/.test(i[0]))[0]; item[1](); });
const adopt = (frame) => frame.evaluate(() => new Promise((res) => { let n = 0; const t = setInterval(() => { const w = $world.submorphs.filter((m) => m.name === 'IdentityPeerDialog')[0]; if (w) { window.__dlg = w; clearInterval(t); setTimeout(() => res(true), 600); } else if (++n > 80) { clearInterval(t); res(false); } }, 100); }));

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const hard = setTimeout(async () => { console.log('HARD TIMEOUT'); for (const c of ctxs) await c.close().catch(() => {}); process.exit(3); }, 420000);
  const A = await device('Maya', 'a'), B = await device('Jun', 'b');
  try {
    // ---- the menu entry and the first screen
    const items = await menuItems(A.frame);
    check('the menu bar offers "Connect a device" for a signed-in local identity', items && items.some((l) => /^Connect a device/.test(l)), items);
    for (const d of [A, B]) { await d.page.bringToFront(); await openFromMenu(d.frame); d.opened = await adopt(d.frame); }
    check('the entry opens the dialog in both browsers', A.opened && B.opened);
    check('the dialog starts at the start screen: two ways in, and a name field filled with the label', await (async () => { const s = await state(A.frame); return s.phase === 'start' && ['makeInvitationBtn', 'haveInvitationBtn', 'nameInput'].every((n) => s.names.includes(n)) && (await textOf(A.frame, 'nameInput')) === 'Maya'; })());
    const cov = await where(A.frame, 'makeInvitationBtn');
    check('its buttons are not covered by anything else on the page', cov && cov.covered === false, cov);
    await A.page.bringToFront(); await shot(A.page, 'dlg-1-start');

    // the other side shows nothing of itself: its name field is emptied (the label stays on the device)
    await B.page.bringToFront();
    await dlg(B.frame, (d) => { const n = d.get('nameInput'); n.setTextString(''); });

    // ---- A: an invitation
    await A.page.bringToFront();
    await click(A.page, A.frame, 'makeInvitationBtn');
    check('"Make an invitation" shows a short code and a place for the answer', !!(await waitFor(async () => (await phase(A.frame)) === 'invited')) && await has(A.frame, 'codeBox') && await has(A.frame, 'pasteBox'));
    const inv = await code(A.frame);
    check('the invitation is a keo2. code of about 130 characters', /^keo2\.[A-Za-z0-9_-]+$/.test(inv) && inv.length < 200, inv && inv.length);
    check('the box shows the code in short lines that read back to the same code', (await textOf(A.frame, 'codeBox')).replace(/\s+/g, '') === inv);
    await shot(A.page, 'dlg-2-invited');
    await A.frame.evaluate(() => { window.__copied = []; const cb = navigator.clipboard; if (cb) { const w = cb.writeText; cb.writeText = function (t) { window.__copied.push(t); return w.apply(cb, arguments); }; } const ex = document.execCommand; document.execCommand = function (c) { if (c === 'copy' && document.activeElement && document.activeElement.value) window.__copied.push(document.activeElement.value); return ex.apply(document, arguments); }; });
    await click(A.page, A.frame, 'copyCodeBtn');
    await sleep(500);
    check('"Copy" asks the browser to copy the whole code (not the wrapped text)', (await A.frame.evaluate(() => window.__copied)).includes(inv));

    // ---- B: takes it. First two mistakes.
    await B.page.bringToFront();
    await click(B.page, B.frame, 'haveInvitationBtn');
    check('"I have an invitation" shows a box to paste it into', !!(await waitFor(async () => (await phase(B.frame)) === 'enter')) && await has(B.frame, 'pasteBox'));
    await click(B.page, B.frame, 'answerBtn');
    await sleep(300);
    check('answering with an empty box says to paste first, and stays', /Paste the invitation/.test((await state(B.frame)).status) && (await phase(B.frame)) === 'enter', await state(B.frame));
    await dlg(B.frame, (d) => { d.get('pasteBox').setTextString('this is not a code'); });
    await click(B.page, B.frame, 'answerBtn');
    check('answering with something that is not a code says so, in words, and stays', !!(await waitFor(async () => /not a keo connection code/.test((await state(B.frame)).status))) && (await phase(B.frame)) === 'enter', await state(B.frame));
    await dlg(B.frame, (d) => { d.get('pasteBox').setTextString(''); });
    // the real loop: A's Copy button put the invitation on the system clipboard above; B pastes it with Ctrl+V
    const pasted = await pasteInto(B.page, B.frame, 'pasteBox');
    check('Copy in one dialog and Ctrl+V in the other carries the invitation (the real clipboard)', typeof pasted === 'string' && pasted.replace(/\s+/g, '').includes(inv), pasted && pasted.slice(0, 80));
    await click(B.page, B.frame, 'answerBtn');
    check('a good invitation gives an answer, shown with a Copy button', !!(await waitFor(async () => (await phase(B.frame)) === 'answered')) && await has(B.frame, 'codeBox') && await has(B.frame, 'copyCodeBtn'));
    const ans = await code(B.frame);
    check('the answer is a short keo2. code too', /^keo2\./.test(ans) && ans.length < 200, ans && ans.length);
    await shot(B.page, 'dlg-3-answered');

    // ---- A: takes the answer. An empty box first.
    await A.page.bringToFront();
    await click(A.page, A.frame, 'connectBtn');
    await sleep(300);
    check('Connect with an empty box says to paste the answer first', /Paste the answer/.test((await state(A.frame)).status));
    // B's Copy, then A's Ctrl+V
    await B.page.bringToFront();
    await click(B.page, B.frame, 'copyCodeBtn');
    await sleep(500);
    await A.page.bringToFront();
    const pastedAns = await pasteInto(A.page, A.frame, 'pasteBox');
    check('and the answer travels back the same way', typeof pastedAns === 'string' && pastedAns.replace(/\s+/g, '').includes(ans), pastedAns && pastedAns.slice(0, 80));
    await click(A.page, A.frame, 'connectBtn');
    const both = await waitFor(async () => (await phase(A.frame)) === 'connected' && (await phase(B.frame)) === 'connected', 40000);
    check('both dialogs move to "connected" by themselves once the other side is proven', !!both, { A: await state(A.frame), B: await state(B.frame) });
    for (const [d, other] of [[A, B], [B, A]]) {
      const av = await dlg(d.frame, (dd) => { let u = null; (function w(m) { if (m.name === 'peerAvatar') u = m.getImageURL(); (m.submorphs || []).forEach(w); })(dd); return u; });
      const want = await d.frame.evaluate((did) => lively.identity.postCardUtils.identiconDataUrl(did, 44), other.did);
      check(d.label + '\'s dialog shows the OTHER identity\'s identicon, from its verified DID', av === want, { av: av && av.slice(0, 40) });
    }
    check('A sees no name for B (B emptied its field)', (await textOf(A.frame, 'peerName')) === '(showed no name)', await textOf(A.frame, 'peerName'));
    check('B sees the name A chose to show', (await textOf(B.frame, 'peerName')) === 'Maya', await textOf(B.frame, 'peerName'));
    const shortA = await A.frame.evaluate((did) => lively.identity.localIdentity.shortDid(did), B.did);
    check('the short DID shown is the other side\'s', (await textOf(A.frame, 'peerDid')) === shortA, [await textOf(A.frame, 'peerDid'), shortA]);
    await A.frame.evaluate(() => { window.__copied = []; });
    await click(A.page, A.frame, 'copyDidBtn');
    await sleep(500);
    check('"Copy DID" copies the other side\'s full DID', (await A.frame.evaluate(() => window.__copied)).includes(B.did), await A.frame.evaluate(() => window.__copied));
    await shot(A.page, 'dlg-4-connected');

    // ---- files and messages are for friends. Connected is not enough: the dialog says so and offers the way forward, which is the
    // shell's own dialog (typed words, a real click), and each side sees the other's half arrive.
    const words = async (P) => P.page.evaluate(() => window.keoFriend.myWords());
    const line = (P) => textOf(P.frame, 'friendLine');
    const addInShell = async (P, theirs) => {
      await P.page.bringToFront();
      await P.page.waitForSelector('#keo-friend:not([hidden])', { timeout: 10000 });
      await P.page.fill('#keo-friend input', theirs.join(' '));
      await P.page.waitForFunction(() => !document.querySelector('#keo-friend button.yes').disabled, null, { timeout: 5000 });
      await P.page.click('#keo-friend button.yes');
      await P.page.waitForSelector('#keo-friend', { state: 'hidden', timeout: 5000 });
    };
    const wA = await words(A), wB = await words(B);
    check('connected but not friends: both dialogs say so, offer "Add as friend…", and offer no file or message button',
      /^Not friends yet/.test(await line(A)) && /^Not friends yet/.test(await line(B)) && await has(A.frame, 'addFriendBtn') && await has(B.frame, 'addFriendBtn')
      && !(await has(A.frame, 'sendFileBtn')) && !(await has(A.frame, 'messageBtn')) && !(await has(B.frame, 'sendFileBtn')) && !(await has(B.frame, 'messageBtn')), [await line(A), await line(B)]);
    await shot(A.page, 'dlg-4b-not-friends');
    await A.page.bringToFront();
    await click(A.page, A.frame, 'addFriendBtn');
    await addInShell(A, wB);
    check('A adds B in the dialog of the shell; the dialog of A then says "You added this device" and has no Add button', !!(await waitFor(async () => /^You added this device/.test(await line(A)))) && !(await has(A.frame, 'addFriendBtn')), await line(A));
    check('the dialog of B learns it by itself: "This device has added you"', !!(await waitFor(async () => /^This device has added you/.test(await line(B)))), await line(B));
    check('and A still has no file or message button (half a friendship)', !(await has(A.frame, 'sendFileBtn')) && !(await has(A.frame, 'messageBtn')));
    await addInShell(B, wA);                 // the shell asked B on its own when A's half arrived
    const friendsNow = await waitFor(async () => /^Friends./.test(await line(A)) && /^Friends./.test(await line(B)));
    check('B adds A: both dialogs say "Friends." and now offer files and messages', !!friendsNow && await has(A.frame, 'sendFileBtn') && await has(A.frame, 'messageBtn') && await has(B.frame, 'sendFileBtn') && await has(B.frame, 'messageBtn'), [await line(A), await line(B)]);
    await shot(A.page, 'dlg-4c-friends');
    await A.page.bringToFront();

    // ---- a file, through the real chooser; B accepts
    const body1 = Buffer.from('hello from the dialog, line by line\n'.repeat(900));
    const fc = A.page.waitForEvent('filechooser', { timeout: 10000 });
    await click(A.page, A.frame, 'sendFileBtn');
    const chooser = await fc.catch(() => null);
    check('"Send a file…" opens the real file chooser', !!chooser);
    if (chooser) await chooser.setFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: body1 });
    check('A\'s dialog lists the file as waiting for B to accept', !!(await waitFor(async () => ((await state(A.frame)).rows || []).join() === 'out:offered')));
    await B.page.bringToFront();
    check('B\'s dialog asks, naming the file and its size', !!(await waitFor(async () => ((await state(B.frame)).rows || []).join() === 'in:asked')) && /note\.txt.*\(\d+(\.\d)? KB\).*wants to send you this/.test(await textOf(B.frame, 'transferLabel')), await textOf(B.frame, 'transferLabel'));
    check('nothing has moved before B answers', (await dlg(B.frame, (d) => d._rows[0].done || 0)) === 0);
    await shot(B.page, 'dlg-5-asked');
    await click(B.page, B.frame, 'acceptBtn');
    check('after Accept the file arrives and Save appears', !!(await waitFor(async () => ((await state(B.frame)).rows || []).join() === 'in:received')) && await has(B.frame, 'saveBtn'));
    const dl = B.page.waitForEvent('download', { timeout: 10000 });
    await click(B.page, B.frame, 'saveBtn');
    const d1 = await dl.catch(() => null);
    let got1 = null; if (d1) { fs.mkdirSync(B.dir, { recursive: true }); const p = path.join(B.dir, 'note.txt'); await d1.saveAs(p); got1 = fs.readFileSync(p); }
    check('Save downloads the file under its name, byte for byte', !!d1 && d1.suggestedFilename() === 'note.txt' && got1 && sha(got1) === sha(body1), d1 && d1.suggestedFilename());
    check('B\'s row says saved', !!(await waitFor(async () => ((await state(B.frame)).rows || []).join() === 'in:saved')));
    await A.page.bringToFront();
    check('A\'s row says delivered', !!(await waitFor(async () => ((await state(A.frame)).rows || []).join() === 'out:delivered')));

    // ---- a file B declines
    await A.page.bringToFront();
    const fc2 = A.page.waitForEvent('filechooser', { timeout: 10000 });
    await click(A.page, A.frame, 'sendFileBtn');
    const chooser2 = await fc2.catch(() => null);
    if (chooser2) await chooser2.setFiles({ name: 'secret.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(5000, 7) });
    await B.page.bringToFront();
    await waitFor(async () => ((await state(B.frame)).rows || []).join() === 'in:saved,in:asked');
    await click(B.page, B.frame, 'declineBtn');
    check('Decline reaches A, whose row says they declined', !!(await waitFor(async () => ((await state(A.frame)).rows || []).join() === 'out:delivered,out:declined')));
    check('and B has no Save for it', (await state(B.frame)).rows.join() === 'in:saved,in:declined' && !(await has(B.frame, 'acceptBtn')));

    // ---- disconnecting, and what the other side sees
    await B.page.bringToFront();
    await click(B.page, B.frame, 'disconnectBtn');
    check('Disconnect takes B back to the start screen', !!(await waitFor(async () => (await phase(B.frame)) === 'start')));
    check('A\'s dialog notices and says disconnected, with a way to start over', !!(await waitFor(async () => (await phase(A.frame)) === 'closed')) && await has(A.frame, 'startOverBtn'));
    await A.page.bringToFront(); await shot(A.page, 'dlg-6-closed');
    await click(A.page, A.frame, 'startOverBtn');
    check('"Start over" returns to the start screen (and keeps the name)', (await phase(A.frame)) === 'start' && (await textOf(A.frame, 'nameInput')) === 'Maya');

    // ---- closing the window ends the connection
    await click(A.page, A.frame, 'makeInvitationBtn');
    await waitFor(async () => (await phase(A.frame)) === 'invited');
    const openBefore = await A.page.evaluate(() => window.keoP2p.list().length);
    await click(A.page, A.frame, 'closeBtn');
    await sleep(800);
    check('Close removes the window', (await dlg(A.frame, (d) => 1)) === null);
    check('and closes the connection it held in the shell', openBefore === 1 && (await A.page.evaluate(() => window.keoP2p.list().length)) === 0, [openBefore, await A.page.evaluate(() => window.keoP2p.list().length)]);
    // the landing page's own video API and location request are refused by the sandbox policy; keo-session-test.js filters the same two
    const mine = errors.filter((e) => !/youtube\.com|Geolocation access/.test(e));
    check('no page errors in either browser (other than the landing page\'s two known ones)', mine.length === 0, mine.slice(0, 5));
  } catch (e) {
    check('the test ran to the end', false, String(e && e.stack || e).slice(0, 700));
    for (const d of [A, B]) console.log('STATE ' + d.name + ': ' + JSON.stringify(await state(d.frame).catch(() => '?')).slice(0, 600));
  } finally {
    clearTimeout(hard);
    for (const c of ctxs) await c.close().catch(() => {});
  }
  console.log((failed ? 'FAILED ' + failed + ', ' : '') + passed + ' passed');
  process.exit(failed ? 1 : 0);
})();
