// End-to-end test of the direct connection and file sharing (shell/keo-p2p.js) in the built keo extension.
// Usage: node keo-p2p-test.js <repo root> <extension folder> <work dir>
// Two headed browsers (two profiles = two devices on one machine; a third is started for one check), each with the package loaded, `localhost` unresolvable and
// its own CDP virtual authenticator. Each makes an identity; then everything is driven the way the world does it, through
// keo.call('p2p.*') over the bridge, and the world's keo.on('p2p') events are read back. The two connection codes are carried
// between the browsers by this script, standing in for a paste.
// NOT covered: two real machines (the browsers share one network stack, so this does not show that a LAN link forms, or what a
// firewall does to it), a real authenticator, a peer that breaks the protocol on purpose (the engine keeps its channel private,
// so a test would have to reach into it), a code that expired by waiting (keo-hello-test.js checks the age rule).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'cgjphijackijgcjkfdfieihkbfooigjp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 700) : '')); }
const errors = [];
const ctxs = [];

const worldFrame = (page) => page.frames().find((f) => /world\.html$/.test(f.url()));
async function waitForWorld(page) {
  for (let i = 0; i < 200; i++) {
    const f = worldFrame(page);
    if (f) { try { if (await f.evaluate(() => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init))) return f; } catch (e) {} }
    await sleep(300);
  }
  throw new Error('the world did not start');
}
const call = (frame, op, args) => frame.evaluate(([o, a]) => window.keo.call(o, a, 60000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [op, args || {}]);
async function waitFor(what, fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 20000)) { const v = await fn().catch(() => null); if (v) return v; await sleep(150); }
  return null;
}
const events = (frame) => frame.evaluate(() => window.__p2p.slice());
const findEvent = (frame, type, pred, ms) => waitFor('event ' + type, async () => (await events(frame)).find((e) => e.type === type && (!pred || pred(e))), ms);
const mkFile = (frame, name, size, seed) => frame.evaluate(async ([n, sz, sd]) => {
  const b = new Uint8Array(sz); let x = sd >>> 0 || 1; for (let i = 0; i < sz; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 255; }
  window.__files = window.__files || {}; window.__files[n] = new File([b], n);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b))).map((v) => v.toString(16).padStart(2, '0')).join('');
}, [name, size, seed]);
const sendFile = (frame, id, name, as) => frame.evaluate(([i, n, a]) => window.keo.call('p2p.send', { id: i, file: window.__files[n], name: a }, 60000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [id, name, as]);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function device(label, name) {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-p2p-' + name), {
    headless: false, viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  ctxs.push(ctx);
  await sleep(2000);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));       // the world's leave-the-page question at teardown: answer it, and do not crash if the browser is already closing
  page.on('pageerror', (e) => errors.push(name + ' PAGEERROR ' + e.message.slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure|ERR_FILE_NOT_FOUND/.test(m.text())) errors.push(name + ' console: ' + m.text().slice(0, 200)); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  await page.goto(`chrome-extension://${ID}/start.html#guest`);
  const frame = await waitForWorld(page);
  await frame.evaluate(() => { window.__p2p = []; window.keo.on('p2p', (e) => window.__p2p.push(e)); });
  return { label, name, ctx, page, frame, dir: path.join(WORK, 'dl-' + name) };
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const hard = setTimeout(async () => { console.log('HARD TIMEOUT'); for (const c of ctxs) await c.close().catch(() => {}); process.exit(3); }, 400000);
  const A = await device('Maya', 'a'), B = await device('Jun', 'b');
  try {
    // ---- 0. nothing works before an identity is signed in
    const pre = await call(A.frame, 'p2p.offer', {});
    check('signed out: an invitation is refused with a sentence', pre.ok === false && /Sign in/.test(pre.e), pre);
    check('the world has no way to sign with the device key (no op for it)', (await call(A.frame, 'identity.deviceProof', {})).ok === false && (await call(A.frame, 'identity.signWithDevice', {})).ok === false);
    for (const d of [A, B]) {
      const r = await d.page.evaluate((l) => window.keoIdentity.create({ label: l }), d.label);
      d.did = r.did;
    }
    check('both devices have an identity and a session', !!A.did && !!B.did && A.did !== B.did && (await call(A.frame, 'session.current')).r.did === A.did && (await call(B.frame, 'session.current')).r.did === B.did);

    // ---- 1. the handshake: invitation (A) -> answer (B) -> finish (A); who is there is proven over the channel, not by the codes
    const t0 = Date.now();
    const inv = await call(A.frame, 'p2p.offer', { name: 'Maya' });
    check('A makes an invitation: a short keo2. text', inv.ok && /^keo2\.[A-Za-z0-9_-]+$/.test(inv.r.code) && inv.r.code.length < 200, inv);
    console.log('INFO invitation is ' + inv.r.code.length + ' characters, made in ' + (Date.now() - t0) + ' ms');
    const invDec = await require('../shell/keo-hello.js').decodeCode(inv.r.code, { role: 'offer' }).catch((e) => e.message);
    check('the invitation holds addresses and credentials and nothing about who made it', typeof invDec === 'object' && invDec.c.length >= 1 && !JSON.stringify(invDec).includes(A.did) && !inv.r.code.includes(A.did.slice(8, 20)), invDec);
    const ans = await call(B.frame, 'p2p.answer', { code: inv.r.code, name: 'Jun' });
    check('B answers with a short code too', ans.ok && /^keo2\./.test(ans.r.code) && ans.r.code.length < 200 && ans.r.peer === undefined, ans);
    console.log('INFO answer is ' + (ans.ok ? ans.r.code.length : '?') + ' characters');
    check('the answering side knows nobody yet: nothing is claimed before the proof', (await call(B.frame, 'p2p.list')).r.every((c) => c.id !== ans.r.id || c.peer === null));

    // refusals that must leave the invitation usable
    const tampered = ans.r.code.slice(0, 40) + (ans.r.code[40] === 'A' ? 'B' : 'A') + ans.r.code.slice(41);
    const badTamper = await call(A.frame, 'p2p.finish', { id: inv.r.id, code: tampered });
    check('A refuses an altered answer at once (the checksum), not after a timeout', badTamper.ok === false && /damaged/.test(badTamper.e), badTamper);
    const wrongRole = await call(A.frame, 'p2p.finish', { id: inv.r.id, code: inv.r.code });
    check('A refuses its own invitation pasted as an answer', wrongRole.ok === false && /invitation/.test(wrongRole.e), wrongRole);
    const inv2 = await call(A.frame, 'p2p.offer', {});
    const notOurs = await call(A.frame, 'p2p.finish', { id: inv2.r.id, code: ans.r.code });
    check('A refuses an answer made for a different invitation', notOurs.ok === false && /not for the invitation/.test(notOurs.e), notOurs);
    const early = await A.frame.evaluate((i) => window.keo.call('p2p.send', { id: i, file: new File(['x'], 'x') }).then(() => true, (e) => e.message), inv2.r.id);
    check('nothing can be sent on a connection that is only an invitation', early !== true && /not ready/.test(early), early);
    await call(A.frame, 'p2p.close', { id: inv2.r.id });
    const noSuch = await call(A.frame, 'p2p.finish', { id: 'nope', code: ans.r.code });
    check('an unknown invitation id is refused', noSuch.ok === false, noSuch);

    const fin = await call(A.frame, 'p2p.finish', { id: inv.r.id, code: ans.r.code });
    check('after those refusals the genuine answer is accepted', fin.ok && fin.r.id === inv.r.id, fin);
    const cA = inv.r.id, cB = ans.r.id;
    const readyA = await findEvent(A.frame, 'state', (e) => e.id === cA && e.state === 'ready');
    const readyB = await findEvent(B.frame, 'state', (e) => e.id === cB && e.state === 'ready');
    check('both sides become ready, each having verified the other\'s proof over the channel', !!readyA && !!readyB, { A: await events(A.frame), B: await events(B.frame) });
    check('A learns B\'s verified DID and the name B chose to show', readyA && readyA.peer.did === B.did && readyA.peer.name === 'Jun', readyA);
    check('B learns A\'s verified DID and the name A chose to show', readyB && readyB.peer.did === A.did && readyB.peer.name === 'Maya', readyB);
    check('the channel was "open" (peer unproven) before it was "ready"', (await events(A.frame)).filter((e) => e.id === cA && e.type === 'state').map((e) => e.state).join(',') === 'invited,connecting,open,ready', (await events(A.frame)).filter((e) => e.id === cA).map((e) => e.state));
    console.log('INFO ready after ' + (Date.now() - t0) + ' ms from the first invitation');
    check('p2p.list shows the ready connection with the peer\'s DID', (await call(A.frame, 'p2p.list')).r.some((c) => c.id === cA && c.state === 'ready' && c.peer.did === B.did));
    const second = await call(B.frame, 'p2p.finish', { id: cB, code: ans.r.code });
    check('finish is only for an invitation (the answering side cannot use it)', second.ok === false, second);

    // someone else's answer: the DID shown is theirs. (A third device answers the same kind of invitation; A is handed THAT answer.)
    const C = await device('Noor', 'c');
    C.did = (await C.page.evaluate((l) => window.keoIdentity.create({ label: l }), C.label)).did;
    const inv3 = await call(A.frame, 'p2p.offer', { name: 'Maya' });
    const ansC = await call(C.frame, 'p2p.answer', { code: inv3.r.code, name: 'Noor' });
    await call(A.frame, 'p2p.finish', { id: inv3.r.id, code: ansC.r.code });
    const readyC = await findEvent(A.frame, 'state', (e) => e.id === inv3.r.id && e.state === 'ready');
    check('an answer from a different device shows THAT device\'s DID, not the one that was expected', !!readyC && readyC.peer.did === C.did && readyC.peer.did !== B.did, readyC);
    await call(A.frame, 'p2p.close', { id: inv3.r.id });
    await C.ctx.close().catch(() => {});

    // ---- 2. a file, only after the receiver says yes
    const h1 = await mkFile(A.frame, 'hello.bin', 300 * 1000 + 17, 7);
    const s1 = await sendFile(A.frame, cA, 'hello.bin');
    check('A offers a file', s1.ok && s1.r.fid >= 1, s1);
    const inc = await findEvent(B.frame, 'incoming', (e) => e.id === cB);
    check('B is asked: name, size and who from', !!inc && inc.name === 'hello.bin' && inc.size === 300017 && inc.peer.did === A.did, inc);
    await sleep(1500);
    const waiting = (await call(B.frame, 'p2p.list')).r.find((c) => c.id === cB).incoming[0];
    check('no byte arrived while B had not answered', waiting && waiting.got === 0 && waiting.state === 'asked', waiting);
    check('B cannot save a file it has not received', (await call(B.frame, 'p2p.save', { id: cB, fid: inc.fid })).ok === false);
    await call(B.frame, 'p2p.respond', { id: cB, fid: inc.fid, accept: true });
    const got = await findEvent(B.frame, 'received', (e) => e.fid === inc.fid);
    check('B receives the whole file', !!got && got.size === 300017, got);
    check('A is told it was delivered', !!(await findEvent(A.frame, 'delivered', (e) => e.fid === s1.r.fid)));
    check('the world got events and sizes but no file bytes', !(await events(B.frame)).some((e) => JSON.stringify(e).length > 2000));
    fs.mkdirSync(B.dir, { recursive: true });
    const dl = B.page.waitForEvent('download', { timeout: 15000 });
    check('B saves it', (await call(B.frame, 'p2p.save', { id: cB, fid: inc.fid })).ok);
    const d1 = await dl.catch((e) => null);
    let bytes1 = null; if (d1) { const p = path.join(B.dir, 'hello.bin'); await d1.saveAs(p); bytes1 = fs.readFileSync(p); }
    check('the saved file is byte for byte the one A sent, under its name', !!d1 && d1.suggestedFilename() === 'hello.bin' && bytes1 && bytes1.length === 300017 && sha(bytes1) === h1, { name: d1 && d1.suggestedFilename(), len: bytes1 && bytes1.length });
    check('a file can be saved only once (it is released after the download)', (await call(B.frame, 'p2p.save', { id: cB, fid: inc.fid })).ok === false);

    // ---- 3. the other direction, a decline, an empty file, a hostile name
    await mkFile(B.frame, 'no.bin', 5000, 9);
    const s2 = await sendFile(B.frame, cB, 'no.bin');
    const inc2 = await findEvent(A.frame, 'incoming', (e) => e.name === 'no.bin');
    await call(A.frame, 'p2p.respond', { id: cA, fid: inc2.fid, accept: false });
    check('a declined offer reaches the sender and nothing is sent', !!(await findEvent(B.frame, 'declined', (e) => e.fid === s2.r.fid)) && !(await events(B.frame)).some((e) => e.type === 'progress' && e.dir === 'out' && e.fid === s2.r.fid));      // the SENDER's side: a receiver that declined would ignore stray chunks
    check('responding twice to one offer is refused', (await call(A.frame, 'p2p.respond', { id: cA, fid: inc2.fid, accept: true })).ok === false);

    await mkFile(A.frame, 'empty.txt', 0, 3);
    const s3 = await sendFile(A.frame, cA, 'empty.txt');
    const inc3 = await findEvent(B.frame, 'incoming', (e) => e.name === 'empty.txt');
    await call(B.frame, 'p2p.respond', { id: cB, fid: inc3.fid, accept: true });
    check('an empty file goes through', !!(await findEvent(B.frame, 'received', (e) => e.fid === inc3.fid && e.size === 0)) && !!(await findEvent(A.frame, 'delivered', (e) => e.fid === s3.r.fid)));
    await call(B.frame, 'p2p.cancel', { id: cB, fid: inc3.fid }).catch(() => {});

    await mkFile(A.frame, 'evil.bin', 100, 5);
    const s4 = await sendFile(A.frame, cA, 'evil.bin', '..\\..//etc/pass‮wd.exe');
    const inc4 = await findEvent(B.frame, 'incoming', (e) => e.fid !== undefined && /pass/.test(e.name));
    check('a path or a direction-changing character in a received name is neutralised', !!inc4 && !/[\\/‮]/.test(inc4.name) && !/^\./.test(inc4.name), inc4 && inc4.name);
    await call(B.frame, 'p2p.respond', { id: cB, fid: inc4.fid, accept: false });

    check('send refuses something that is not a file', (await A.frame.evaluate((i) => window.keo.call('p2p.send', { id: i, file: 'not a file' }).then(() => true, (e) => e.message), cA)) !== true);
    check('send on an unknown connection is refused', (await A.frame.evaluate(() => window.keo.call('p2p.send', { id: 'nope', file: new File(['x'], 'x') }).then(() => true, () => false))) === false);

    // ---- 4. a larger file (the sender has to pace itself), and a cancel part way
    const big = 6 * 1024 * 1024 + 123;
    const h5 = await mkFile(B.frame, 'big.bin', big, 11);
    const tBig = Date.now();
    const s5 = await sendFile(B.frame, cB, 'big.bin');
    const inc5 = await findEvent(A.frame, 'incoming', (e) => e.name === 'big.bin');
    await call(A.frame, 'p2p.respond', { id: cA, fid: inc5.fid, accept: true });
    const got5 = await findEvent(A.frame, 'received', (e) => e.fid === inc5.fid, 120000);
    console.log('INFO ' + (big / 1048576).toFixed(1) + ' MiB took ' + (Date.now() - tBig) + ' ms');
    check('a 6 MiB file arrives complete', !!got5 && got5.size === big, got5);
    const dl5 = A.page.waitForEvent('download', { timeout: 15000 });
    await call(A.frame, 'p2p.save', { id: cA, fid: inc5.fid });
    const d5 = await dl5.catch(() => null);
    let ok5 = false; if (d5) { fs.mkdirSync(A.dir, { recursive: true }); const p = path.join(A.dir, 'big.bin'); await d5.saveAs(p); ok5 = sha(fs.readFileSync(p)) === h5; }
    check('and it is intact', ok5);
    check('progress events were sent while it moved', (await events(A.frame)).filter((e) => e.type === 'progress' && e.fid === inc5.fid).length >= 3);

    await mkFile(A.frame, 'long.bin', 40 * 1024 * 1024, 13);
    const s6 = await sendFile(A.frame, cA, 'long.bin');
    const inc6 = await findEvent(B.frame, 'incoming', (e) => e.name === 'long.bin');
    await call(B.frame, 'p2p.respond', { id: cB, fid: inc6.fid, accept: true });
    await findEvent(B.frame, 'progress', (e) => e.fid === inc6.fid && e.done > 0);
    check('B cancels a transfer in progress', (await call(B.frame, 'p2p.cancel', { id: cB, fid: inc6.fid })).ok);
    check('A is told it was cancelled and stops', !!(await findEvent(A.frame, 'cancelled', (e) => e.fid === s6.r.fid)));
    await sleep(800);
    const doneAfter = (await events(B.frame)).filter((e) => e.type === 'progress' && e.fid === inc6.fid).pop();
    await sleep(800);
    const doneLater = (await events(B.frame)).filter((e) => e.type === 'progress' && e.fid === inc6.fid).pop();
    check('no more data of the cancelled file arrives', doneAfter && doneLater && doneAfter.done === doneLater.done && doneLater.done < 40 * 1024 * 1024, { doneAfter, doneLater });
    await mkFile(B.frame, 'after.txt', 1000, 17);
    await sendFile(B.frame, cB, 'after.txt');
    const inc7 = await findEvent(A.frame, 'incoming', (e) => e.name === 'after.txt');
    await call(A.frame, 'p2p.respond', { id: cA, fid: inc7.fid, accept: true });
    check('the connection still works after a cancel', !!(await findEvent(A.frame, 'received', (e) => e.fid === inc7.fid)));

    // ---- 5. closing
    check('A closes the connection', (await call(A.frame, 'p2p.close', { id: cA })).ok);
    check('B is told, and has no connection left', !!(await findEvent(B.frame, 'state', (e) => e.id === cB && e.state === 'closed')) && (await call(B.frame, 'p2p.list')).r.length === 0);

    // a new pair, and sign-out closes it
    const i3 = await call(A.frame, 'p2p.offer', {});
    const a3 = await call(B.frame, 'p2p.answer', { code: i3.r.code });
    await call(A.frame, 'p2p.finish', { id: i3.r.id, code: a3.r.code });
    await findEvent(B.frame, 'state', (e) => e.id === a3.r.id && e.state === 'ready');
    await call(A.frame, 'session.signOut', {}).catch(() => {});
    check('signing out closes the connections, and the other side hears it', !!(await findEvent(B.frame, 'state', (e) => e.id === a3.r.id && e.state === 'closed')));

    // ---- 6. a session that EXPIRES ends what belongs to it just as signing out does. The page's clock is faked before the sign-in,
    // so the session's expiry timer is the fake clock's and a jump of 13 hours (the session lasts 12) fires it without waiting.
    await sleep(2500);                                              // the sign-out reloads A's page
    A.frame = await waitForWorld(A.page);
    await A.frame.evaluate(() => { window.__p2p = []; window.keo.on('p2p', (e) => window.__p2p.push(e)); });
    await A.page.clock.install();
    await A.page.evaluate((d) => window.keoIdentity.signIn({ did: d }), A.did);
    const i4 = await call(A.frame, 'p2p.offer', {});
    const a4 = await call(B.frame, 'p2p.answer', { code: i4.r.code });
    await call(A.frame, 'p2p.finish', { id: i4.r.id, code: a4.r.code });
    const up4 = await findEvent(B.frame, 'state', (e) => e.id === a4.r.id && e.state === 'ready');
    await call(B.frame, 'dm.send', { id: a4.r.id, text: 'said before the session ended' });
    const msgWaiting = await waitFor('a message waiting on A', async () => (await A.page.evaluate(() => window.keoDm.take())).length === 1);
    check('before the expiry: A has a session, a ready connection and a message nobody has taken', !!up4 && !!msgWaiting && (await A.page.evaluate(() => window.keoIdentity.current())) !== null);
    await A.page.clock.fastForward('13:00:00');
    check('when the session expires the connection is closed and the other side hears it', !!(await findEvent(B.frame, 'state', (e) => e.id === a4.r.id && e.state === 'closed')));
    check('and A has no session, no connection and no message left for the next identity to take', (await A.page.evaluate(() => window.keoIdentity.current())) === null
      && (await A.page.evaluate(() => window.keoP2p.list())).length === 0 && (await A.page.evaluate(() => window.keoDm.take())).length === 0);
    check('no page errors in either browser', errors.length === 0, errors.slice(0, 5));
  } catch (e) {
    check('the test ran to the end', false, String(e && e.stack || e).slice(0, 600));
    for (const d of [A, B]) console.log('EVENTS ' + d.name + ': ' + JSON.stringify(await events(d.frame).catch(() => '?')).slice(0, 1500));
  } finally {
    clearTimeout(hard);
    for (const c of ctxs) await c.close().catch(() => {});
  }
  console.log((failed ? 'FAILED ' + failed + ', ' : '') + passed + ' passed');
  process.exit(failed ? 1 : 0);
})();
