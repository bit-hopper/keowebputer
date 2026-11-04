// End-to-end test of calls (shell/keo-call.js, the panel in start.html) in the built keo extension, and of the rules that keep a
// hostile world and a hostile peer from using them.
// Usage: node keo-call-test.js <repo root> <extension folder> <work dir>
// Two headed browsers (two profiles = two devices on one machine), each with the package loaded, `localhost` unresolvable, its own
// virtual authenticator and the browser's fake camera and microphone (the camera plays a generated moving picture; the permission
// prompt is answered by a flag). The connection is made through the world's bridge as in keo-p2p-test.js; calls are asked for
// the way the world does it (keo.call('call.start')) and ANSWERED by real mouse clicks on the panel, which is the point: the
// panel belongs to the shell page and only a click there starts the camera.
// NOT covered: a real camera, microphone or permission prompt (the flags stand in), two real machines, other browsers, how the
// picture and sound look or sound (frame counts and a changing picture are measured, nothing is seen or heard), the kernel's
// Messages window (keo-messages-test.js), a real authenticator.
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'cgjphijackijgcjkfdfieihkbfooigjp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 900) : '')); }
const errors = [];
const ctxs = [];

// 60 frames of a 320x240 picture that moves, in the plain y4m format the browser can play as a camera.
function makeY4m(file) {
  if (fs.existsSync(file)) return;
  const W = 320, H = 240, frames = [Buffer.from('YUV4MPEG2 W' + W + ' H' + H + ' F30:1 Ip A1:1 C420jpeg\n')];
  for (let f = 0; f < 60; f++) {
    const y = Buffer.alloc(W * H), u = Buffer.alloc(W * H / 4, 128 + (f * 2) % 100), v = Buffer.alloc(W * H / 4, 90 + (f * 3) % 120);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) y[r * W + c] = ((c + f * 9) & 63) < 32 ? 40 + (r & 127) : 200 - (r & 127);
    frames.push(Buffer.from('FRAME\n'), y, u, v);
  }
  fs.writeFileSync(file, Buffer.concat(frames));
}

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
async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 20000)) { const v = await fn().catch(() => null); if (v) return v; await sleep(150); }
  return null;
}
const p2pEvents = (P) => P.frame.evaluate(() => window.__p2p.slice());
const findP2p = (P, type, pred, ms) => waitFor(async () => (await p2pEvents(P)).find((e) => e.type === type && (!pred || pred(e))), ms);
const calls = (P) => P.frame.evaluate(() => window.__calls.slice());
const mark = async (P) => (await calls(P)).length;
const waitCall = (P, state, from, ms, pred) => waitFor(async () => (await calls(P)).slice(from).find((e) => e.state === state && (!pred || pred(e))), ms);
const panel = (P) => P.page.evaluate(() => {
  const r = document.getElementById('keo-call');
  if (!r) return null;
  const rect = r.getBoundingClientRect();
  return { hidden: r.hidden, name: r.querySelector('.who-name').textContent, did: r.querySelector('.who-did').textContent, didFull: r.querySelector('.who-did').title,
    status: r.querySelector('.status').textContent, acts: Array.from(r.querySelectorAll('button[data-act]')).map((b) => b.dataset.act), img: r.querySelector('.who-img').src,
    note: r.querySelector('.note').hidden ? '' : r.querySelector('.note').textContent, z: getComputedStyle(r).zIndex, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
});
const waitPanel = (P, pred, ms) => waitFor(async () => { const p = await panel(P); return p && pred(p) ? p : null; }, ms);
const click = (P, act) => P.page.click('#keo-call button[data-act="' + act + '"]', { timeout: 8000 });
const shot = (P, n) => process.env.SHOT_DIR ? P.page.screenshot({ path: path.join(process.env.SHOT_DIR, n + '.png') }) : null;
const gum = (P) => P.page.evaluate(() => window.__gum);
const liveTracks = (P) => P.page.evaluate(() => window.__streams.reduce((n, s) => n + s.getTracks().filter((t) => t.readyState === 'live').length, 0));
const shortDid = (did) => { const m = /^did:keo:[^:]+:([A-Za-z0-9_-]{43})$/.exec(did); return 'keo:' + m[1].slice(0, 4) + '…' + m[1].slice(-4); };
const stats = (P, id) => P.page.evaluate(async (i) => {
  const pc = window.keoP2p.handle(i).pc, st = await pc.getStats(), o = { transports: 0, audio: 0, video: 0, frames: 0, mediaTx: pc.getTransceivers().length };
  st.forEach((s) => {
    if (s.type === 'transport') o.transports++;
    if (s.type === 'inbound-rtp') { if (s.kind === 'audio') o.audio = s.packetsReceived; if (s.kind === 'video') { o.video = s.packetsReceived; o.frames = s.framesDecoded; } }
  });
  return o;
}, id);
// a small grey-scale fingerprint of what the remote video element shows now
const picture = (P) => P.page.evaluate(() => {
  const v = document.querySelector('#keo-call .remote');
  if (!v || v.hidden || !v.videoWidth) return null;
  const c = document.createElement('canvas'); c.width = 16; c.height = 12; const g = c.getContext('2d'); g.drawImage(v, 0, 0, 16, 12);
  return Array.from(g.getImageData(0, 0, 16, 12).data).filter((_, i) => i % 4 === 0).join(',');
});

async function device(label, name) {
  const y4m = path.join(WORK, 'fake-camera.y4m');
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-call-' + name), {
    headless: false, viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`, '--autoplay-policy=no-user-gesture-required'] });
  ctxs.push(ctx);
  // Counts every capture the SHELL page asks for and keeps the streams, so the test can say when the camera was asked for and
  // that every track is stopped afterwards.
  await ctx.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:' || !navigator.mediaDevices) return;
    window.__gum = 0; window.__streams = [];
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { window.__gum++; const s = await orig(c); window.__streams.push(s); return s; };
  });
  await sleep(2000);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('pageerror', (e) => errors.push(name + ' PAGEERROR ' + e.message.slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure|ERR_FILE_NOT_FOUND/.test(m.text())) errors.push(name + ' console: ' + m.text().slice(0, 200)); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  await page.goto(`chrome-extension://${ID}/start.html#guest`);
  const frame = await waitForWorld(page);
  await frame.evaluate(() => { window.__p2p = []; window.__calls = []; window.keo.on('p2p', (e) => window.__p2p.push(e)); window.keo.on('call', (e) => window.__calls.push(e)); });
  const did = (await page.evaluate((l) => window.keoIdentity.create({ label: l }), label)).did;
  return { label, name, ctx, page, frame, did };
}
async function connect(A, B) {
  const inv = await call(A.frame, 'p2p.offer', { name: A.label });
  const ans = await call(B.frame, 'p2p.answer', { code: inv.r.code, name: B.label });
  await call(A.frame, 'p2p.finish', { id: inv.r.id, code: ans.r.code });
  const ra = await findP2p(A, 'state', (e) => e.id === inv.r.id && e.state === 'ready'), rb = await findP2p(B, 'state', (e) => e.id === ans.r.id && e.state === 'ready');
  if (!ra || !rb) throw new Error('the devices did not connect');
  return { a: inv.r.id, b: ans.r.id };
}
const send = (P, id, m) => P.page.evaluate(([i, x]) => window.keoP2p.handle(i).send(x), [id, m]);

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  makeY4m(path.join(WORK, 'fake-camera.y4m'));
  const hard = setTimeout(async () => { console.log('HARD TIMEOUT'); for (const c of ctxs) await c.close().catch(() => {}); process.exit(3); }, 500000);
  const A = await device('Maya', 'a'), B = await device('Jun', 'b');
  try {
    let k = await connect(A, B);

    // ---- 1. a hostile world: it can ask, and that is all
    check('before any call the panel is not shown', ((await panel(A)) || { hidden: true }).hidden === true);
    let a0 = await mark(A);
    const st = await call(A.frame, 'call.start', { id: k.a });
    check('the world can ask for a call', st.ok && typeof st.r.cid === 'string', st);
    const pr = await waitPanel(A, (p) => !p.hidden && /^Call Jun\?/.test(p.status));
    check('that only puts a prompt in front of the person: "Call Jun?" with the choices', !!pr && pr.acts.join() === 'go-video,go-audio,cancel', pr);
    check('the prompt names the peer by the identity proven over the channel: name, short DID, full DID, the identicon', !!pr && pr.name === 'Jun' && pr.did === shortDid(B.did) && pr.didFull === B.did && /^data:image\/png/.test(pr.img), pr);
    await shot(A, 'call-1-prompt');
    await sleep(3000);
    check('with no click nothing is captured, however long the prompt stays', (await gum(A)) === 0 && (await liveTracks(A)) === 0);
    const again = await call(A.frame, 'call.start', { id: k.a });
    check('a second request while a prompt is up is refused', again.ok === false && /already in progress/.test(again.e), again);
    await A.page.evaluate(() => document.querySelector('#keo-call button[data-act="go-video"]').click());     // a script click, not a person's
    await sleep(800);
    check('a click that is not a real one (a script) does nothing', (await gum(A)) === 0 && /^Call Jun\?/.test((await panel(A)).status));
    const unknown = [];
    for (const op of ['call.accept', 'call.answer', 'call.respond', 'call.show', 'call.hide', 'call.move', 'call.resize', 'call.style', 'call.capture', 'call.stream', 'call.place']) {
      const r = await call(A.frame, op, { id: k.a }); if (r.ok || !/unknown op/.test(r.e)) unknown.push([op, r]);
    }
    check('the world has no op to accept, answer, move, hide, resize, restyle or read a call', unknown.length === 0, unknown);
    const dom = await A.frame.evaluate(() => { try { return typeof parent.document.title; } catch (e) { return e.name; } });
    check('the world cannot reach the shell page\'s elements', dom === 'SecurityError', dom);
    check('the panel sits below the identity vault\'s unlock frame in z-order', Number(pr.z) < 2147483647 && Number(pr.z) > 0, pr.z);
    // Make the two overlap, show the vault the way the world can, and see which is on top at a point in both.
    await A.page.setViewportSize({ width: 520, height: 330 });
    await sleep(300);
    await call(A.frame, 'vault.frame', { shown: true });
    await A.page.waitForFunction(() => document.getElementById('vault').classList.contains('shown') && document.getElementById('vault').getBoundingClientRect().width > 100);
    const over = await A.page.evaluate(() => {
      const p = document.getElementById('keo-call').getBoundingClientRect(), v = document.getElementById('vault').getBoundingClientRect();
      const x = Math.round((Math.max(p.left, v.left) + Math.min(p.right, v.right)) / 2), y = Math.round((Math.max(p.top, v.top) + Math.min(p.bottom, v.bottom)) / 2);
      const overlap = Math.min(p.right, v.right) > Math.max(p.left, v.left) && Math.min(p.bottom, v.bottom) > Math.max(p.top, v.top);
      const top = document.elementFromPoint(x, y);
      return { overlap: overlap, top: top && (top.id || top.tagName) };
    });
    check('where the call panel and the unlock frame overlap, the unlock frame is on top', over.overlap && over.top === 'vault', over);
    await call(A.frame, 'vault.frame', { shown: false });
    await A.page.setViewportSize({ width: 1000, height: 700 });
    await click(A, 'cancel');
    const dis = await waitCall(A, 'ended', a0);
    check('Cancel dismisses the prompt, without capture and without telling the other side', !!dis && /Dismissed/.test(dis.why) && (await gum(A)) === 0 && (await mark(B)) === 0);
    const hid = await waitPanel(A, (p) => p.hidden);
    check('the panel goes away with the call', !!hid);
    const nag = await call(A.frame, 'call.start', { id: k.a });
    check('a prompt that was dismissed cannot be put up again at once', nag.ok === false && /dismissed a moment ago/.test(nag.e), nag);
    const later = await waitFor(async () => { const r = await call(A.frame, 'call.start', { id: k.a }); return r.ok ? r : null; }, 15000);
    check('and can again after a few seconds', !!later);
    await click(A, 'cancel');
    await waitPanel(A, (p) => p.hidden);
    await sleep(10500);

    // ---- 2. a call, answered by clicks
    a0 = await mark(A); let b0 = await mark(B);
    check('start the call', (await call(A.frame, 'call.start', { id: k.a })).ok);
    await waitPanel(A, (p) => !p.hidden && p.acts.includes('go-video'));
    await click(A, 'go-video');
    const inc = await waitPanel(B, (p) => !p.hidden && /is calling/.test(p.status));
    check('the other side sees who is calling (name, short DID, picture) and that it is a video call', !!inc && inc.name === 'Maya' && inc.did === shortDid(A.did) && /video/.test(inc.status) && inc.acts.join() === 'accept,accept-audio,decline', inc);
    await shot(B, 'call-2-incoming');
    check('A captured only after its own click; B has captured nothing yet', (await gum(A)) === 1 && (await gum(B)) === 0);
    check('the caller\'s panel says the camera and microphone are on while it rings', /Calling.*camera and microphone on/.test((await panel(A)).status), await panel(A));
    // the same picture the runtime draws for that DID
    const kernelIcon = await B.frame.evaluate((did) => new Promise((res) => { lively.require('lively.identity.PostCardUtils').toRun(() => res(lively.identity.postCardUtils.identiconDataUrl(did, 80))); }), A.did);
    check('the panel\'s picture is the one the runtime draws for that DID', inc.img === kernelIcon, { shell: inc.img.slice(0, 60), kernel: String(kernelIcon).slice(0, 60) });
    await click(B, 'accept');
    const actA = await waitCall(A, 'active', a0, 30000), actB = await waitCall(B, 'active', b0, 30000);
    check('both sides reach "active"', !!actA && !!actB, { A: (await calls(A)).slice(a0).map((e) => e.state), B: (await calls(B)).slice(b0).map((e) => e.state) });
    check('B captured once, after its click; each side holds a live camera and microphone', (await gum(B)) === 1 && (await liveTracks(A)) === 2 && (await liveTracks(B)) === 2);
    await sleep(2500);
    const sA = await stats(A, k.a), sB = await stats(B, k.b);
    check('media flows both ways: video frames decoded and audio received', sA.frames > 10 && sB.frames > 10 && sA.audio > 20 && sB.audio > 20, { sA, sB });
    check('it all rides the one connection that was proven (a single transport)', sA.transports === 1 && sB.transports === 1, { sA, sB });
    const p1 = await picture(A); await sleep(700); const p2 = await picture(A);
    check('A\'s remote video element shows a picture that changes (B\'s camera)', !!p1 && !!p2 && p1 !== p2, { p1: !!p1, p2: !!p2 });
    const live = await panel(A);
    await shot(A, 'call-3-active-A'); await shot(B, 'call-4-active-B');
    check('the active panel shows the controls and the identity', live.acts.join() === 'mic,cam,hang' && live.name === 'Jun' && live.did === shortDid(B.did), live);
    check('the world was told: a video call, active, with the peer and no stream', !!actA && actA.video === true && actA.peer.did === B.did && actA.dir === 'out' && !('stream' in actA) && actB.dir === 'in' && actB.peer.did === A.did, actA);

    // controls
    await click(A, 'mic');
    const muted = await waitCall(A, 'active', a0 + 1, 5000, (e) => e.mic === false);
    check('Mute turns the microphone off for the call (the world is told)', !!muted && await A.page.evaluate(() => window.__streams.every((s) => s.getAudioTracks().every((t) => !t.enabled))));
    await click(A, 'mic');
    check('Unmute turns it back on', !!(await waitCall(A, 'active', a0 + 1, 5000, (e) => e.mic === true)));
    await click(A, 'cam');
    const camOff = await waitCall(A, 'active', a0 + 1, 8000, (e) => e.cam === false);
    check('Camera off stops the camera itself, not just the picture', !!camOff && await A.page.evaluate(() => window.__streams.every((s) => s.getVideoTracks().every((t) => t.readyState === 'ended'))));
    const remoteOff = await waitCall(B, 'active', b0 + 1, 10000, (e) => e.remoteVideo === false);
    check('the other side learns the picture stopped (their panel falls back to the identicon)', !!remoteOff);
    await click(A, 'cam');
    const camOn = await waitCall(A, 'active', a0 + 1, 10000, (e) => e.cam === true);
    check('Camera on starts it again (a click, a new capture)', !!camOn && (await gum(A)) === 2);
    const back = await waitCall(B, 'active', b0 + 1, 10000, (e) => e.remoteVideo === true);
    check('and the picture returns on the other side', !!back);

    // hang up from the other end
    const a1 = await mark(A), b1 = await mark(B);
    await click(B, 'hang');
    const endA = await waitCall(A, 'ended', a1), endB = await waitCall(B, 'ended', b1);
    check('hanging up ends it on both sides, and says who', !!endA && !!endB && /other side ended/.test(endA.why) && /Hung up/.test(endB.why), { endA, endB });
    check('both panels disappear', !!(await waitPanel(A, (p) => p.hidden)) && !!(await waitPanel(B, (p) => p.hidden)));
    check('every camera and microphone track is stopped', (await liveTracks(A)) === 0 && (await liveTracks(B)) === 0, { a: await liveTracks(A), b: await liveTracks(B) });
    check('the connection itself is still up for files and the next call', (await call(A.frame, 'p2p.list')).r.some((c) => c.id === k.a && c.state === 'ready'));

    // ---- 3. a second call on the same connection, audio only, started from the other side
    a0 = await mark(A); b0 = await mark(B);
    const before = await stats(A, k.a);
    check('B asks for a call', (await call(B.frame, 'call.start', { id: k.b })).ok);
    await waitPanel(B, (p) => !p.hidden && p.acts.includes('go-audio'));
    await click(B, 'go-audio');
    const inc2 = await waitPanel(A, (p) => !p.hidden && /is calling/.test(p.status));
    check('an audio-only call is offered as that: Accept and Decline only', !!inc2 && !/video/.test(inc2.status) && inc2.acts.join() === 'accept,decline', inc2);
    await click(A, 'accept');
    const act2 = [await waitCall(A, 'active', a0, 30000), await waitCall(B, 'active', b0, 30000)];
    check('both active again on the same connection', !!act2[0] && !!act2[1], { A: (await calls(A)).slice(a0).map((e) => e.state + (e.why ? ':' + e.why : '')), B: (await calls(B)).slice(b0).map((e) => e.state + (e.why ? ':' + e.why : '')),
      closed: (await p2pEvents(A)).concat(await p2pEvents(B)).filter((e) => e.state === 'closed').map((e) => e.why) });
    await sleep(2000);
    const after = await stats(A, k.a);
    check('audio flows, no video section was added, still one transport', after.audio > 20 && after.transports === 1 && after.mediaTx === before.mediaTx, { before, after });
    check('an audio-only call has no camera in it', (await liveTracks(A)) === 1 && (await liveTracks(B)) === 1 && (await panel(A)).acts.join() === 'mic,hang');
    await click(A, 'hang');
    check('and it ends the same way', !!(await waitCall(B, 'ended', b0)) && (await liveTracks(A)) === 0 && (await liveTracks(B)) === 0);

    // ---- 4. declined, cancelled, busy
    a0 = await mark(A); b0 = await mark(B);
    const gumB = await gum(B);
    await call(A.frame, 'call.start', { id: k.a }); await waitPanel(A, (p) => p.acts.includes('go-video')); await click(A, 'go-video');
    await waitPanel(B, (p) => /is calling/.test(p.status));
    await click(B, 'decline');
    const dec = await waitCall(A, 'ended', a0);
    check('Decline: the caller is told and its camera stops; the callee never captured', !!dec && /Declined/.test(dec.why) && (await gum(B)) === gumB && (await liveTracks(A)) === 0, dec);
    await waitPanel(B, (p) => p.hidden);
    const b2 = await mark(B);
    await send(A, k.a, { t: 'call.ring', cid: 'FFFFFFFFFFFF', video: false });          // rung again at once, as a nagging peer would
    await sleep(1500);
    check('a peer that rings again right after a decline gets no panel', ((await panel(B)) || { hidden: true }).hidden && (await mark(B)) === b2);
    await sleep(5200);
    a0 = await mark(A); b0 = await mark(B);
    await call(A.frame, 'call.start', { id: k.a }); await waitPanel(A, (p) => p.acts.includes('go-video')); await click(A, 'go-video');
    await waitPanel(B, (p) => /is calling/.test(p.status));
    await click(A, 'cancel');
    check('Cancel while it rings: the other side\'s panel goes away, nothing was captured there', !!(await waitPanel(B, (p) => p.hidden)) && (await gum(B)) === gumB && (await liveTracks(A)) === 0);
    await sleep(5200);
    // busy: B is in a call (placed by A), and A asks the world for another on the same connection
    a0 = await mark(A); b0 = await mark(B);
    await call(A.frame, 'call.start', { id: k.a }); await waitPanel(A, (p) => p.acts.includes('go-audio')); await click(A, 'go-audio');
    await waitPanel(B, (p) => /is calling/.test(p.status)); await click(B, 'accept');
    await waitCall(A, 'active', a0, 30000);
    const busy = await call(A.frame, 'call.start', { id: k.a });
    check('while a call is going, a request for another is refused', busy.ok === false && /already in progress/.test(busy.e), busy);
    // a connection that drops ends the call
    await call(B.frame, 'p2p.close', { id: k.b });
    const gone = await waitCall(A, 'ended', a0, 15000);
    check('closing the connection ends the call on the other side', !!gone && !!(await waitPanel(A, (p) => p.hidden)) && (await liveTracks(A)) === 0 && (await liveTracks(B)) === 0, gone);

    // ---- 5. a hostile peer (this script sends raw messages from A's shell page)
    k = await connect(A, B);
    a0 = await mark(A); b0 = await mark(B);
    await send(A, k.a, { t: 'call.sdp', cid: 'AAAAAAAAAAAA', type: 'offer', sdp: 'v=0\r\n' });
    await send(A, k.a, { t: 'call.accept', cid: 'AAAAAAAAAAAA', video: true });
    await send(A, k.a, { t: 'call.end', cid: 'AAAAAAAAAAAA' });
    await sleep(1500);
    check('messages for a call that does not exist are ignored (the connection stays up, no panel)', (await call(B.frame, 'p2p.list')).r.some((c) => c.id === k.b && c.state === 'ready') && ((await panel(B)) || { hidden: true }).hidden && (await mark(B)) === b0);
    // a call that is rung for real, accepted by a click, and then given a description for another certificate
    await sleep(5300);                                            // (the ring limit: one a few seconds apart, across connections)
    await send(A, k.a, { t: 'call.ring', cid: 'BBBBBBBBBBBB', video: false });
    await waitPanel(B, (p) => /is calling/.test(p.status));
    await click(B, 'accept');
    await waitCall(B, 'connecting', b0, 15000);
    const forged = ['v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
      'a=ice-ufrag:abcd', 'a=ice-pwd:abcdefghijklmnopqrstuv', 'a=fingerprint:sha-256 ' + 'AB:'.repeat(31) + 'AB', 'a=setup:actpass', 'a=mid:0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=ice-ufrag:abcd', 'a=ice-pwd:abcdefghijklmnopqrstuv', 'a=fingerprint:sha-256 ' + 'AB:'.repeat(31) + 'AB', 'a=setup:actpass', 'a=mid:1', ''].join('\r\n');
    await send(A, k.a, { t: 'call.sdp', cid: 'BBBBBBBBBBBB', type: 'offer', sdp: forged });
    const closedB = await findP2p(B, 'state', (e) => e.id === k.b && e.state === 'closed', 10000);
    check('a description for a certificate other than the proven one closes the connection, with the reason', !!closedB && /different certificate/.test(closedB.why || ''), closedB);
    check('and the call and its capture end with it', !!(await waitPanel(B, (p) => p.hidden)) && (await liveTracks(B)) === 0);

    k = await connect(A, B);
    await send(A, k.a, { t: 'call.ring', cid: 'CCCCCCCCCCCC', video: 'yes' });
    const closedB2 = await findP2p(B, 'state', (e) => e.id === k.b && e.state === 'closed', 10000);
    check('a malformed call message closes the connection', !!closedB2 && /bad call message/.test(closedB2.why || ''), closedB2);

    k = await connect(A, B);
    b0 = await mark(B);
    await send(A, k.a, { t: 'call.ring', cid: 'DDDDDDDDDDDD', video: false });
    await waitPanel(B, (p) => /is calling/.test(p.status));
    await send(A, k.a, { t: 'call.ring', cid: 'EEEEEEEEEEEE', video: false });          // a second ring while one is up: refused as busy, no second panel
    await sleep(1200);
    const events = (await calls(B)).slice(b0);
    check('a second ring while one is showing does not make a second call', events.filter((e) => e.state === 'incoming').length === 1, events.map((e) => e.state));
    await call(B.frame, 'call.end', { id: k.b });
    check('the world may end a call (it lowers what the world can do)', !!(await waitCall(B, 'ended', b0)));
  } catch (e) {
    failed++; console.log('FAIL test crashed: ' + (e && e.stack || e));
  }
  check('no page errors or console errors', errors.length === 0, errors.slice(0, 5));
  for (const c of ctxs) await c.close().catch(() => {});
  clearTimeout(hard);
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
