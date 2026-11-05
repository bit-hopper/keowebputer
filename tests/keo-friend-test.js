// End-to-end test of friends: messages, calls and file offers work only between friends, and two devices become friends only when each
// person types the other's eight words into the shell's own dialog (shell/keo-friend.js, keo-contacts.js, keo-fingerprint.js).
// Usage: node keo-friend-test.js <repo root> <extension folder> <work dir>
// Two headed browsers (two profiles = two devices on one machine), each with the package loaded, `localhost` unresolvable and its own
// virtual authenticator. The connection is made through the world's bridge (as keo-p2p-test.js does); the dialogs are answered the way a
// person does: real typing, real clicks. A hostile peer is imitated by sending raw messages from one shell page.
// NOT covered: two real machines, a real authenticator, how the dialog looks (set SHOT_DIR and look), a session that expires, the kernel's
// own screens for friends (not built yet).
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
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
const lastState = async (P, id) => (await p2pEvents(P)).filter((e) => e.type === 'state' && e.id === id).pop();
const listed = (P, id) => P.frame.evaluate((i) => window.keo.call('p2p.list', {}, 20000).then((l) => l.filter((c) => c.id === i)[0] || null), id);
const send = (P, id, m) => P.page.evaluate(([i, x]) => window.keoP2p.handle(i).send(x), [id, m]);
const shot = (page, n) => process.env.SHOT_DIR ? page.screenshot({ path: path.join(process.env.SHOT_DIR, n + '.png') }) : null;

async function device(label, name) {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-fr-' + name), {
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
  await page.goto(`chrome-extension://${ID}/start.html`);
  let frame = await waitForWorld(page, 'gate');
  const created = await page.evaluate((l) => window.keoIdentity.create({ label: l }), label);
  await frame.evaluate(() => window.keo.call('world.go', { kind: 'enter' }, 60000)).catch(() => {});
  frame = await waitForWorld(page, 'homestar');
  await frame.evaluate(() => { window.__p2p = []; window.keo.on('p2p', (e) => window.__p2p.push(e)); window.__fr = []; window.keo.on('friend', (e) => window.__fr.push(e)); });
  const P = { label, name, ctx, page, frame, did: created.did };
  P.words = (await call(frame, 'friend.words')).r;
  return P;
}
async function connect(A, B) {
  const inv = await call(A.frame, 'p2p.offer', { name: A.label });
  const ans = await call(B.frame, 'p2p.answer', { code: inv.r.code, name: B.label });
  await call(A.frame, 'p2p.finish', { id: inv.r.id, code: ans.r.code });
  const ra = await findP2p(A, 'state', (e) => e.id === inv.r.id && e.state === 'ready'), rb = await findP2p(B, 'state', (e) => e.id === ans.r.id && e.state === 'ready');
  if (!ra || !rb) throw new Error('the devices did not connect');
  return { a: inv.r.id, b: ans.r.id };
}
// The dialog as a person sees it.
const dlg = (P) => P.page.evaluate(() => {
  const r = document.getElementById('keo-friend');
  if (!r) return null;
  const q = (s) => r.querySelector(s);
  return { hidden: r.hidden, title: q('.title').textContent, name: q('.who-name').textContent, did: q('.who-did').textContent, didFull: q('.who-did').title, img: q('.who-img').src.slice(0, 22),
    mine: q('.words').textContent, hint: q('.hint').textContent, hintClass: q('.hint').className, yesDisabled: q('button.yes').disabled, text: r.textContent, value: q('input').value, z: getComputedStyle(r).zIndex };
});
const dlgOpen = (P) => waitFor(async () => { const d = await dlg(P); return d && !d.hidden ? d : null; }, 10000);
const dlgGone = (P) => waitFor(async () => { const d = await dlg(P); return !d || d.hidden ? true : null; }, 8000);
const confirmShown = (P) => waitFor(async () => P.page.evaluate(() => { const r = document.getElementById('keo-confirm'); return r && !r.hidden ? r.textContent : null; }), 8000);
// A person adds the other device: types its words (which the other person read out) and clicks Add.
async function addFriend(P, other) {
  await P.page.bringToFront();
  const d = await dlgOpen(P);
  if (!d) throw new Error('no dialog for ' + P.label);
  await P.page.fill('#keo-friend input', other.words.join(' '));
  await waitFor(async () => (await dlg(P)).yesDisabled === false ? true : null, 5000);
  await P.page.click('#keo-friend button[data-ans="yes"]');
  await dlgGone(P);
}
const disk = (P) => P.page.evaluate(() => new Promise((res, rej) => {
  const q = indexedDB.open('keo-contacts');
  q.onerror = () => rej(q.error);
  q.onsuccess = () => { const db = q.result, t = db.transaction(['book'], 'readonly'), r = t.objectStore('book').getAll(); r.onsuccess = () => { db.close(); res(r.result.map((x) => ({ did: x.did, keys: Object.keys(x), ct: Array.from(new Uint8Array(x.ct)) }))); }; };
}));
const hasText = (bytes, text) => { const needle = Array.from(new TextEncoder().encode(text)); outer: for (let i = 0; i + needle.length <= bytes.length; i++) { for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer; return true; } return false; };

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const hard = setTimeout(async () => { console.log('HARD TIMEOUT'); for (const c of ctxs) await c.close().catch(() => {}); process.exit(3); }, 420000);
  const A = await device('Maya', 'a'), B = await device('Jun', 'b');
  try {
    // ---- 0. our words
    check('each device can read its own eight words (the list\'s words, all different from the other\'s)', A.words.length === 8 && B.words.length === 8 && A.words.join() !== B.words.join(), { a: A.words, b: B.words });
    let k = await connect(A, B);

    // ---- 1. a stranger can connect, and can do nothing but ask
    const st = await lastState(A, k.a);
    check('a connection to a device that is not a friend is ready, and says so: not a friend, not added, not added us', st.state === 'ready' && st.friend === false && st.added === false && st.theirs === false, st);
    const dm = await call(A.frame, 'dm.send', { id: k.a, text: 'hello' });
    check('a message to a non-friend is refused with a sentence', dm.ok === false && /only message a friend/.test(dm.e), dm);
    const cs = await call(A.frame, 'call.start', { id: k.a });
    check('a call to a non-friend is refused', cs.ok === false && /only call a friend/.test(cs.e), cs);
    const fs1 = await A.frame.evaluate((i) => window.keo.call('p2p.send', { id: i, file: new Blob(['x']), name: 'x.txt' }, 20000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), k.a);
    check('a file offer to a non-friend is refused', fs1.ok === false && /only share files with a friend/.test(fs1.e), fs1);
    check('and none of that put a dialog up or touched the book', ((await dlg(A)) || { hidden: true }).hidden && (await call(A.frame, 'friend.list')).r.length === 0);

    // ---- 2. a hostile peer: everything but "I added you" closes the connection
    for (const [what, msg] of [['a message', { t: 'dm.text', mid: 'AAAAAAAAAAAA', text: 'hi' }], ['a call', { t: 'call.ring', cid: 'BBBBBBBBBBBB', video: false }], ['a file offer', { t: 'file', fid: 1, name: 'x.txt', size: 1 }]]) {
      await send(B, k.b, msg);
      const closed = await findP2p(A, 'state', (e) => e.id === k.a && e.state === 'closed', 10000);
      check('from a device that is not a friend, ' + what + ' closes the connection', !!closed && /not a friend/.test(closed.why || ''), closed);
      k = await connect(A, B);
    }
    await send(B, k.b, { t: 'friend.set', added: 'yes' });
    const bad = await findP2p(A, 'state', (e) => e.id === k.a && e.state === 'closed', 10000);
    check('a friend message that is not true or false closes it too', !!bad && /bad message/.test(bad.why || ''), bad);
    k = await connect(A, B);

    // ---- 3. the dialog: the world can only ask
    check('the world has no op that adds a friend, answers the dialog or hides it', await (async () => { const bad = []; for (const op of ['friend.add', 'friend.accept', 'friend.set', 'friend.answer', 'friend.hide', 'friend.show', 'friend.words.of']) { const r = await call(A.frame, op, { id: k.a, did: B.did }); if (r.ok || !/unknown op/.test(r.e)) bad.push([op, r]); } return bad.length === 0 ? true : bad; })());
    await A.page.bringToFront();
    check('the world asks for the dialog', (await call(A.frame, 'friend.start', { id: k.a })).ok);
    const d1 = await dlgOpen(A);
    check('the dialog names the device by the proven identity: name, short DID, full DID, a picture', !!d1 && d1.title === 'Add Jun as a friend?' && d1.name === 'Jun' && /^keo:.{4}….{4}$/.test(d1.did) && d1.didFull === B.did && /^data:image\/png/.test(d1.img), d1);
    check('it shows OUR words to read out, and nothing of the other device\'s', !!d1 && d1.mine === A.words.join(' ') && !d1.text.includes(B.words.join(' ')) && d1.value === '', d1);
    // (not "none of B's words occurs in the text": the list has ordinary words like "call" and "match", and the dialog's own sentences use some, so one of B's eight is among them in about one run in ten)
    check('it sits below the identity vault\'s unlock frame', !!d1 && Number(d1.z) < 2147483647 && Number(d1.z) > 0, d1 && d1.z);
    await shot(A.page, 'friend-1-dialog');
    check('the Add button is off until words are typed', d1.yesDisabled === true);
    const again = await call(A.frame, 'friend.start', { id: k.a });
    check('asking again while it is up is refused', again.ok === false && /already waiting/.test(again.e), again);
    await A.page.fill('#keo-friend input', 'zzzz ' + B.words.slice(1).join(' '));
    check('a word that is not on the list is said so', /not one of the words/.test((await dlg(A)).hint) && (await dlg(A)).yesDisabled === true, await dlg(A));
    await A.page.fill('#keo-friend input', B.words.slice(0, 7).join(' '));
    check('seven words are "7 of 8" and do not enable it', (await dlg(A)).hint === '7 of 8 words.' && (await dlg(A)).yesDisabled === true, await dlg(A));
    await A.page.fill('#keo-friend input', A.words.join(' '));
    const wrong = await waitFor(async () => { const d = await dlg(A); return /not their words/.test(d.hint) ? d : null; }, 5000);
    check('eight words that are NOT theirs (here: our own) are refused with a warning', !!wrong && wrong.yesDisabled === true && wrong.hintClass === 'hint bad', wrong);
    await A.page.click('#keo-friend button.yes', { force: true, timeout: 2000 }).catch(() => {});
    check('and clicking the disabled button changes nothing', (await call(A.frame, 'friend.list')).r.length === 0 && !(await dlg(A)).hidden);
    await A.page.fill('#keo-friend input', B.words.map((w, i) => (i % 3 === 0 ? w.toUpperCase() : w)).join(',  '));
    const match = await waitFor(async () => { const d = await dlg(A); return d.yesDisabled === false ? d : null; }, 5000);
    check('their eight words match (any case, commas and spaces): "They match." and Add wakes', !!match && match.hint === 'They match.' && match.hintClass === 'hint good', match);
    await A.page.evaluate(() => document.querySelector('#keo-friend button.yes').click());           // a script click, not a person's
    await sleep(800);
    check('a click that is not a real one (a script) adds nobody', (await call(A.frame, 'friend.list')).r.length === 0 && !(await dlg(A)).hidden);
    await A.page.click('#keo-friend button.yes');
    check('a real click adds them, and the dialog goes', !!(await dlgGone(A)) && (await call(A.frame, 'friend.list')).r.some((p) => p.did === B.did && p.name === 'Jun'));

    // ---- 4. half a friendship is not one
    const sa = await findP2p(A, 'friendship', (e) => e.id === k.a && e.added === true);
    check('A has added B, but B has not added A: not friends yet', !!sa && sa.friend === false && sa.theirs === false, sa);
    const dB = await dlgOpen(B);
    check('B is told: "Maya has added you as a friend", with the same dialog', !!dB && dB.title === 'Maya has added you as a friend' && dB.didFull === A.did && dB.mine === B.words.join(' '), dB);
    const sb = await findP2p(B, 'friendship', (e) => e.id === k.b && e.theirs === true);
    check('B\'s connection knows A has added it, but B has not added A', !!sb && sb.friend === false && sb.added === false, sb);
    check('still no message either way', (await call(A.frame, 'dm.send', { id: k.a, text: 'hi' })).ok === false && (await call(B.frame, 'dm.send', { id: k.b, text: 'hi' })).ok === false);
    await send(A, k.a, { t: 'dm.text', mid: 'CCCCCCCCCCCC', text: 'sneaky' });
    const sneak = await findP2p(B, 'state', (e) => e.id === k.b && e.state === 'closed', 8000);
    check('and a message A sends anyway is a violation on B\'s side (B has not added A)', !!sneak && /not a friend/.test(sneak.why || ''), sneak);
    k = await connect(A, B);
    // the book is remembered, "they added us" is not: on the new connection A has B, B is told again
    const sa2 = await findP2p(A, 'state', (e) => e.id === k.a && e.state === 'ready');
    check('a new connection remembers who A added, and does not remember that B had not', !!sa2 && sa2.added === true && sa2.friend === false, sa2);

    // ---- 5. the second half: both have added the other
    const dB2 = await dlgOpen(B);
    check('on the new connection A tells B again that it has added B, and B is asked again (the closed connection took the old dialog with it)', !!dB2 && dB2.title === 'Maya has added you as a friend', dB2);
    await addFriend(B, A);
    const fa = await findP2p(A, 'friendship', (e) => e.id === k.a && e.friend === true), fb = await findP2p(B, 'friendship', (e) => e.id === k.b && e.friend === true);
    check('both connections now say: friends', !!fa && !!fb, { fa, fb });
    const m1 = await call(A.frame, 'dm.send', { id: k.a, text: 'hello Jun' });
    check('a message goes', m1.ok === true, m1);
    const got = await waitFor(async () => { const r = await call(B.frame, 'dm.take'); return r.ok && r.r.length ? r.r : null; }, 8000);
    check('and arrives, from A\'s proven identity', !!got && got[0].text === 'hello Jun' && got[0].peer.did === A.did, got);
    const f1 = await A.frame.evaluate((i) => window.keo.call('p2p.send', { id: i, file: new Blob(['hello']), name: 'a.txt' }, 20000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), k.a);
    const inc = await findP2p(B, 'incoming', (e) => e.id === k.b, 8000);
    check('a file offer goes too', f1.ok === true && !!inc && inc.name === 'a.txt', { f1, inc });
    const c1 = await call(A.frame, 'call.start', { id: k.a });
    check('a call prompt can be put up', c1.ok === true, c1);
    await A.page.click('#keo-call button[data-act="cancel"]');

    // ---- 6. what is on disk
    const dA = await disk(A);
    const bytes = dA[0] ? dA[0].ct : [];
    check('the book is one encrypted record: the peer\'s DID and name are not readable in it', dA.length === 1 && dA[0].did === A.did && bytes.length > 40 && !hasText(bytes, B.did) && !hasText(bytes, 'Jun') && !hasText(bytes, 'did:keo'), { n: dA.length, keys: dA[0] && dA[0].keys });

    // ---- 7. removing a friend: confirmed in the shell, the other side is told, the connection ends
    await A.page.bringToFront();
    const rm = call(A.frame, 'friend.remove', { did: B.did });
    const q = await confirmShown(A);
    check('removing a friend asks the person first, worded by the shell, with the device named', !!q && /Remove this friend\?/.test(q) && /Jun/.test(q), q);
    await A.page.click('#keo-confirm button[data-ans="yes"]');
    check('after a real yes it is removed', (await rm).ok === true && (await call(A.frame, 'friend.list')).r.length === 0, await rm);
    const ca = await findP2p(A, 'state', (e) => e.id === k.a && e.state === 'closed', 8000), cb = await findP2p(B, 'state', (e) => e.id === k.b && e.state === 'closed', 8000);
    // (which end notices first varies: B closes as soon as it hears "removed", A when its own book is written, so A's reason may be
    // either; B, which is told, always says why)
    check('both ends of the connection close, and the one that was removed is told why', !!ca && !!cb && /no longer friends/.test(cb.why || ''), { ca, cb });
    check('B still has A in its list (it is B\'s own decision), but they are not friends', (await call(B.frame, 'friend.list')).r.some((p) => p.did === A.did));
    // B still has A added, so on a new connection B says so: A, who removed B, is asked again (and can say not now)
    k = await connect(A, B);
    const dA2 = await dlgOpen(A);
    check('B still has A added: on a new connection A is asked again, and nothing is a friend yet', !!dA2 && dA2.title === 'Jun has added you as a friend' && (await lastState(A, k.a)).friend === false, dA2);
    await A.page.click('#keo-friend button[data-ans="no"]');
    check('"Not now" closes it and adds nobody', !!(await dlgGone(A)) && (await call(A.frame, 'friend.list')).r.length === 0);
    const soon = await call(A.frame, 'friend.start', { id: k.a });
    check('the world cannot put it straight back', soon.ok === false && /dismissed a moment ago/.test(soon.e), soon);

    // ---- 7b. a connection that is lost while the person is reading words aloud
    await sleep(10500);                                       // the "not now" above keeps the dialog down for ten seconds
    await A.page.bringToFront();
    check('once the dismissal has aged, the world can ask again', (await call(A.frame, 'friend.start', { id: k.a })).ok === true);
    check('and the dialog is up', !!(await dlgOpen(A)));
    await call(B.frame, 'p2p.close', { id: k.b });
    const lost = await findP2p(A, 'state', (e) => e.id === k.a && e.state === 'closed', 8000);
    check('the other end goes away: the connection closes here', !!lost && /other side closed/.test(lost.why || ''), lost);
    await sleep(500);
    const dl = await dlg(A);
    check('but the dialog stays, and says the connection has ended', !!dl && !dl.hidden && /connection has ended/.test(dl.text), dl);
    await A.page.fill('#keo-friend input', B.words.join(' '));
    const dlOk = await waitFor(async () => { const d = await dlg(A); return d.yesDisabled === false ? d : null; }, 5000);
    check('their words are still checked against the device that proved itself, and match', !!dlOk && dlOk.hint === 'They match.', dlOk);
    await A.page.click('#keo-friend button.yes');
    check('and a real click still adds them, with no connection', !!(await dlgGone(A)) && (await call(A.frame, 'friend.list')).r.some((p) => p.did === B.did));
    const dg = await A.page.evaluate(() => window.keoP2p.diag());
    check('the connection log says how it ended: marked lost, with the last known state of the path', /closed The other side closed the connection\. \[lost\] \| .*pc /.test(dg), dg.split('\n').slice(-6));

    // ---- 8. removing an identity removes its friends
    await A.page.evaluate((d) => window.keoContacts.purge(d), A.did);
    check('purge leaves no record', (await disk(A)).length === 0);
  } catch (e) {
    failed++; console.log('FAIL test crashed: ' + (e && e.stack || e));
  }
  const mine = errors.filter((e) => !/youtube\.com|Geolocation access|Not connected to this device/.test(e));
  check('no page errors or console errors (other than the landing page\'s two known ones)', mine.length === 0, mine.slice(0, 5));
  for (const c of ctxs) await c.close().catch(() => {});
  clearTimeout(hard);
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
