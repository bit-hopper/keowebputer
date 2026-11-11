// The dialog for adding an identity to a second device (shell/keo-enroll.js), by REAL clicks and typing in two browsers that are two
// origins (the second package is built here under a throwaway key). The world only asks for the dialog, through the real bridge; the
// codes that pass between the devices are carried by this script, standing in for a person's paste, a message or a saved file, except
// where a real file chooser and a real download are used on purpose.
// Usage: node keo-enroll-ui-test.js <repo root> <package folder> <work dir>
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const { idOfPackage, buildSecond, launch: launchIn } = require('./two-origins.js');
const launch = (dir, profile) => launchIn(chromium, dir, profile, WORK);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 600) : '')); }
async function poll(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(150); } return null; }

async function waitForWorld(page) {
  let frame = null;
  for (let i = 0; i < 100 && !frame; i++) { frame = page.frames().find((f) => /world\.html$/.test(f.url())); if (!frame) await sleep(200); }
  for (let i = 0; i < 150; i++) { try { if (await frame.evaluate(() => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init))) break; } catch (e) {} await sleep(300); }
  await sleep(1000);
  return frame;
}
const op = (frame, name, args) => frame.evaluate(([o, a]) => window.keo.call(o, a || {}, 60000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [name, args]);
// where a morph found by `pick` is, in page coordinates (the world sits in an iframe); null while there is none
async function rectOf(page, frame, pick, arg) {
  const r = await frame.evaluate(([src, a]) => { const m = (new Function('return (' + src + ')'))()(a); if (!m) return null; const n = m.renderContext().shapeNode; const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, [pick.toString(), arg]);
  if (!r) return null;
  const off = await (await frame.frameElement()).boundingBox();
  return { x: off.x + r.x, y: off.y + r.y, w: r.w, h: r.h };
}
const shell = (page, fn, arg) => page.evaluate(async ([src, a]) => {
  try { return { ok: true, r: await (new Function('return (' + src + ')')())(a) }; } catch (e) { return { ok: false, err: (e && e.name) + ': ' + (e && e.message) }; }
}, [fn.toString(), arg]);
// What the dialog shows right now, read off the page. `words` is only the words in a group that is on screen.
const dlg = (P) => P.page.evaluate(() => {
  const r = document.getElementById('keo-enroll'); if (!r) return null;
  const vis = (e) => e && !e.hidden && !e.closest('[hidden]');
  const q = (s) => r.querySelector(s);
  const yes = q('button.yes');
  return { hidden: r.hidden, title: q('.title').textContent, text: q('.text').textContent, hint: q('.hint').textContent, hintClass: q('.hint').className,
    whole: r.textContent, words: [...r.querySelectorAll('.words')].filter(vis).map((e) => e.textContent).join('|'),
    out: [...r.querySelectorAll('textarea[readonly]')].filter(vis).map((e) => e.value)[0] || null,
    hasIn: [...r.querySelectorAll('textarea:not([readonly])')].some(vis), hasTyped: vis(q('input.typed')), hasName: vis(q('input.name')),
    yesText: yes.textContent, yesDisabled: yes.disabled, yesHidden: !vis(yes), noText: q('button.no').textContent,
    whoDid: vis(q('.head')) ? q('.who-did').textContent : null, whoImg: vis(q('.head')) ? q('.who-img').src.slice(0, 20) : null };
});
const IN = '#keo-enroll textarea:not([readonly])', TYPED = '#keo-enroll input.typed', YES = '#keo-enroll button.yes', NO = '#keo-enroll button.no';

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const second = buildSecond(REPO, WORK);
  const ID_A = idOfPackage(EXT), ID_B = second.id;
  const A = await launch(EXT, 'profile-enrollui-a'), B = await launch(second.dir, 'profile-enrollui-b');
  try {
    for (const [P, id] of [[A, ID_A], [B, ID_B]]) { await P.page.goto(`chrome-extension://${id}/start.html#guest`); P.frame = await waitForWorld(P.page); }

    // the identity on A (set up through the shell; the dialog is what is under test)
    const dialogsB = [];
    B.page.on('dialog', (x) => { dialogsB.push(x.type()); x.accept().catch(() => {}); });
    const made = await shell(A.page, () => window.keoIdentity.create({ label: 'Alice laptop' }));
    const DID = made.r && made.r.did;
    check('setup: A has a signed-in identity', made.ok && /^did:keo:/.test(DID), made);
    const idWords = await shell(A.page, (d) => window.keoFingerprint.words(d), DID);

    // ---- the world can only ask
    const unknown = [];
    for (const name of ['enroll.answer', 'enroll.approve', 'enroll.fill', 'enroll.grant', 'enroll.complete', 'enroll.hide', 'enroll.read']) { const r = await op(A.frame, name); if (r.ok || !/unknown|no such|not (a )?known/i.test(r.e || '')) unknown.push([name, r]); }
    check('the world has no op that fills the dialog in, approves, completes, reads or hides it', unknown.length === 0, unknown);
    const bad = await op(A.frame, 'enroll.open', { mode: 'sideways' });
    check('an unknown way of asking is refused with a sentence', !bad.ok && /Unknown way/.test(bad.e), bad);
    const noneYet = await dlg(A);
    check('and nothing is on screen yet', !noneYet || noneYet.hidden, noneYet);
    const nobody = await op(B.frame, 'enroll.open', { mode: 'old' });
    check('B has nobody signed in, so it cannot be the old device', !nobody.ok && /Sign in first/.test(nobody.e), nobody);

    // ---- the NEW device (B)
    await B.page.bringToFront();
    // The entries a person has: the menu bar's own menu (nobody signed in) and the sign-in window's button. The button is clicked for real.
    const menuB = await B.frame.evaluate(() => { const bar = $world.get(/MenuBar/), e = $world.get('IdentityMenuBarEntry') || (bar && bar.submorphs.filter((m) => m.name === 'IdentityMenuBarEntry')[0]); return e ? e.morphMenuItems().map((i) => i[0]) : null; });
    check('B: with nobody signed in the menu offers "Link this webputer to an identity ..."', !!menuB && menuB.includes('Link this webputer to an identity ...') && menuB.includes('sign in'), menuB);
    await B.frame.evaluate(() => { lively.require('lively.identity.LoginDialog').toRun(function () { lively.BuildSpec('lively.identity.LoginDialog').createMorph().openInWorldCenter(); }); });
    const linkRect = await poll(() => rectOf(B.page, B.frame, () => { let hit = null; (function walk(m) { if (hit) return; if (m.name === 'linkWebputerBtn' && m.renderContext && m.renderContext().shapeNode && m.renderContext().shapeNode.getBoundingClientRect().width > 0) hit = m; (m.submorphs || []).forEach(walk); })($world); return hit; }), 20000);
    check('B: the sign-in window has a "Link this webputer to an identity ..." button', !!linkRect, linkRect);
    await B.page.mouse.click(linkRect.x + linkRect.w / 2, linkRect.y + linkRect.h / 2);
    check('B: a real click on it puts the shell dialog up', !!(await poll(async () => { const x = await dlg(B); return x && !x.hidden ? x : null; }, 5000)));
    let d = await dlg(B);
    check('B: the dialog opens on its first step: a name, one button, nothing else', !!d && !d.hidden && d.title === 'Link this webputer to an identity' && d.hasName && !d.hasIn && !d.hasTyped && d.out === null && d.yesText === 'Make a code' && !d.yesDisabled, d);
    const again = await op(B.frame, 'enroll.open', { mode: 'new' });
    check('B: asked again while it is up, the world is refused', !again.ok && /already waiting/.test(again.e), again);
    check('B: the name field is asked for as a webName', (await B.page.evaluate(() => { const i = document.querySelector('#keo-enroll input.name'); return { aria: i.getAttribute('aria-label'), text: i.closest('#keo-enroll').textContent }; })).aria === 'webName for this identity on this webputer' && /webName for this identity on this webputer/.test((await B.page.evaluate(() => document.querySelector('#keo-enroll').textContent))));
    await B.page.fill('#keo-enroll input.name', 'Alice desktop');
    await B.page.click(YES);
    check('B: a real click makes the code', !!(await poll(async () => (await dlg(B)).out, 15000)));
    d = await dlg(B);
    const reqCode = d.out, reqWords = d.words;
    check('B: it shows a request code, eight words for it, and a box for the reply', /^keo-enroll-request\./.test(reqCode) && reqWords.split(' ').length === 8 && d.hasIn && d.yesDisabled && d.yesText === 'Link this webputer', d);
    check('B: it does not show the words of any identity (it does not know one yet)', !d.whole.includes(idWords.r.join(' ')));

    // ---- a wrong kind of code, a cut-short one, nonsense
    await B.page.fill(IN, reqCode);
    d = await poll(async () => { const x = await dlg(B); return /request code/.test(x.hint) ? x : null; }, 3000);
    check('B: pasting its own request where the reply goes is told what it is and what is needed', !!d && /That is a request code\. A reply code is needed here\./.test(d.hint) && d.hintClass.includes('bad'), d);
    await B.page.fill(IN, 'hello');
    d = await poll(async () => { const x = await dlg(B); return /not a valid code/.test(x.hint) ? x : null; }, 3000);
    check('B: nonsense is "not a valid code"', !!d, d);

    // ---- the OLD device (A)
    await A.page.bringToFront();
    // A `#guest` page never resumes a session: reload A on the plain page so its world is signed in, as a person's would be.
    await A.page.goto(`chrome-extension://${ID_A}/start.html`); A.frame = await waitForWorld(A.page);
    const signedIn = await poll(() => A.frame.evaluate(() => !!(lively.identity.did && lively.identity.did.isLoggedIn())), 20000);
    check('A: the plain page resumes the session, so the world is signed in', !!signedIn);
    // The world reports itself signed in a moment before its menu bar has the identity entry: wait for the entry, not for a fixed time.
    const entryUp = await poll(() => A.frame.evaluate(() => { const bar = $world.get(/MenuBar/), e = $world.get('IdentityMenuBarEntry') || (bar && bar.submorphs.filter((m) => m.name === 'IdentityMenuBarEntry')[0]); return !!(e && e.morphMenuItems().some((i) => i[0] === 'Identity')); }), 20000);
    check('A: the menu bar has its identity entry', !!entryUp);
    const menuA = await A.frame.evaluate(() => { const bar = $world.get(/MenuBar/), e = $world.get('IdentityMenuBarEntry') || (bar && bar.submorphs.filter((m) => m.name === 'IdentityMenuBarEntry')[0]); const top = e ? e.morphMenuItems() : null, sub = top && (top.filter((i) => i[0] === 'Identity')[0] || [])[1]; return { top: top && top.map((i) => i[0]), sub: sub && sub.map((i) => i[0]) }; });
    check('A: signed in, "Link a new webputer ..." is under Identity and not at the top', !!menuA.sub && menuA.sub.includes('Link a new webputer ...') && !menuA.top.some((l) => /^Link /.test(l)), menuA);
    await A.frame.evaluate(() => { const bar = $world.get(/MenuBar/), e = $world.get('IdentityMenuBarEntry') || bar.submorphs.filter((m) => m.name === 'IdentityMenuBarEntry')[0]; const sub = e.morphMenuItems().filter((i) => i[0] === 'Identity')[0][1]; sub.filter((i) => /^Link a new webputer/.test(i[0]))[0][1](); });
    check('A: the menu entry puts the shell dialog up', !!(await poll(async () => { const x = await dlg(A); return x && !x.hidden ? x : null; }, 5000)));
    d = await dlg(A);
    check('A: it shows the words of the identity signed in, and a box for the code', !!d && d.words === idWords.r.join(' ') && d.hasIn && d.whoDid && d.yesDisabled && d.title === 'Link a new webputer to this identity', d);
    check('A: it has no words of the new device on screen', !d.whole.includes(reqWords));
    await A.page.fill(IN, 'keo-enroll-request.' + 'A'.repeat(30));
    d = await poll(async () => { const x = await dlg(A); return x.hint ? x : null; }, 3000);
    check('A: a damaged request code is "not a valid code" and nothing moves on', !!d && /not a valid code/.test(d.hint) && !d.hasTyped, d);
    await A.page.fill(IN, reqCode);
    d = await poll(async () => { const x = await dlg(A); return x.hasTyped ? x : null; }, 5000);
    check('A: the request code moves it on to asking for the words, and says where the new passkey lives', !!d && d.yesDisabled && d.text.includes('chrome-extension://' + ID_B) && d.yesText === 'Approve this webputer', d);
    check('A: the words of the new device are still not on screen anywhere', !!d && !d.whole.includes(reqWords) && d.out === null, d);
    check('A: the words of the identity are still on screen while it waits for the typed words (the new device asks for them last)', !!d && d.words === idWords.r.join(' '), d);
    await A.page.fill(TYPED, 'abandon ability able about above absent absorb abstract');
    d = await poll(async () => { const x = await dlg(A); return x.hintClass.includes('bad') ? x : null; }, 3000);
    check('A: wrong words keep Approve off, with a warning', !!d && d.yesDisabled && /Those are not the words/.test(d.hint), d);
    await A.page.fill(TYPED, reqWords.split(' ').slice(0, 5).join(' '));
    d = await poll(async () => { const x = await dlg(A); return /of 8 words/.test(x.hint) ? x : null; }, 3000);
    check('A: five of eight words say so', !!d && d.yesDisabled && /5 of 8/.test(d.hint), d);
    await A.page.fill(TYPED, reqWords.replace(/^\w+/, 'zzzz'));
    d = await poll(async () => { const x = await dlg(A); return /not one of the words/.test(x.hint) ? x : null; }, 3000);
    check('A: a word that is not on the list is told apart from a wrong one', !!d && d.yesDisabled, d);
    await A.page.fill(TYPED, reqWords.toUpperCase().replace(/ /g, ',  '));
    d = await poll(async () => { const x = await dlg(A); return !x.yesDisabled ? x : null; }, 5000);
    check('A: the right words (any case, commas) wake Approve', !!d && /They match/.test(d.hint) && d.hintClass.includes('good'), d);
    await A.page.click(YES);
    d = await poll(async () => { const x = await dlg(A); return x.out ? x : null; }, 15000);
    const grantCode = d && d.out;
    check('A: a real click on Approve (one passkey prompt) gives a reply code', !!grantCode && /^keo-enroll-grant\./.test(grantCode) && d.yesHidden && d.hasIn && d.noText === 'Close', d);
    check('A: after approving, the words of the identity are still on screen for the new device to ask for, and the request words are not', !!d && d.words === idWords.r.join(' ') && !d.whole.includes(reqWords), d);
    check('A: the reply is only sealed data: the account secret is not in it as text', !!grantCode && !Buffer.from(grantCode.replace(/^keo-enroll-grant\./, ''), 'base64url').toString().includes('"wrappedAccountSecret"'));

    // ---- back on B: the reply
    await B.page.bringToFront();
    await B.page.fill(IN, grantCode);
    d = await poll(async () => { const x = await dlg(B); return x.hasTyped ? x : null; }, 8000);
    check('B: the reply moves it on, naming the identity by picture and short DID', !!d && /^keo:.{4}….{4}$/.test(d.whoDid) && /^data:image/.test(d.whoImg) && d.yesDisabled, d);
    check('B: the words of the identity are not on its screen to copy', !!d && !d.whole.includes(idWords.r.join(' ')));
    await B.page.fill(TYPED, reqWords);                            // the REQUEST words are not the identity's
    d = await poll(async () => { const x = await dlg(B); return x.hintClass.includes('bad') ? x : null; }, 3000);
    check('B: the words of the request are not accepted for the identity', !!d && d.yesDisabled, d);
    await B.page.fill(TYPED, idWords.r.join(' '));
    d = await poll(async () => { const x = await dlg(B); return !x.yesDisabled ? x : null; }, 5000);
    check('B: the identity\'s words wake Link this webputer', !!d && /They match/.test(d.hint), d);
    await B.page.click(YES);
    d = await poll(async () => { const x = await dlg(B); return x.out && /^keo-enroll-done\./.test(x.out) ? x : null; }, 15000);
    const doneCode = d && d.out;
    check('B: a real click links the webputer and gives a finished code to take back', !!doneCode && d.yesHidden && d.noText === 'Close' && /now has the identity/.test(d.text), d);
    const stored = await shell(B.page, async (did) => { const l = await window.keoIdentity.list(); const c = await window.keoIdentity.current(); return { list: l.filter((x) => x.did === did)[0], session: c && c.did }; }, DID);
    check('B: the identity is on B with two passkeys, recoverable, and B is signed in', stored.ok && stored.r.list && stored.r.list.authorityKeys === 2 && stored.r.list.notRecoverable === false && stored.r.session === DID, stored);

    // ---- Save as file on B: a real download
    const dl = B.page.waitForEvent('download', { timeout: 10000 });
    await B.page.click('#keo-enroll button[data-act=save]');
    const download = await dl;
    const savedPath = path.join(WORK, 'saved-done.txt');
    await download.saveAs(savedPath);
    const saved = fs.readFileSync(savedPath, 'utf8');
    check('B: "Save as file" downloads the finished code, byte for byte, under a clear name', download.suggestedFilename() === 'keo-enroll-done.txt' && saved.trim() === doneCode, download.suggestedFilename());

    // ---- the finished code to A, through a real file chooser
    await A.page.bringToFront();
    const fc = A.page.waitForEvent('filechooser', { timeout: 10000 });
    await A.page.click('#keo-enroll button[data-act=open]');
    await (await fc).setFiles(savedPath);
    d = await poll(async () => { const x = await dlg(A); return /Done\./.test(x.hint) ? x : null; }, 8000);
    check('A: the saved file, opened through the real file chooser, brings A\'s list up to date', !!d && /lists 2 passkeys/.test(d.hint) && d.hintClass.includes('good'), d);
    const aList = await shell(A.page, async (did) => (await window.keoIdentity.list()).filter((x) => x.did === did)[0], DID);
    check('A: and A\'s own record now has two passkeys and is recoverable', aList.ok && aList.r.authorityKeys === 2 && aList.r.notRecoverable === false, aList);
    await A.page.fill(IN, 'keo-enroll-done.' + Buffer.from('{"v":1,"kind":"enroll-done","did":"x","events":[]}').toString('base64url'));
    d = await poll(async () => { const x = await dlg(A); return x.hintClass.includes('good') && /Done\./.test(x.hint) ? x : null; }, 3000);
    check('A: a finished code that adds nothing changes nothing and is not an error', !!d, d);
    await A.page.fill(IN, 'keo-enroll-done.' + Buffer.from(JSON.stringify({ events: [{ event: { v: 1, type: 'add-authority', seq: 1 }, sigs: {} }] })).toString('base64url'));
    d = await poll(async () => { const x = await dlg(A); return x.hintClass.includes('bad') ? x : null; }, 3000);
    check('A: a finished code with a log that does not verify is refused with a sentence', !!d && /does not verify|disagrees/.test(d.hint), d);

    // ---- closing
    await A.page.click(NO);
    check('A: Close hides the dialog and leaves nothing typed or pasted behind', (await dlg(A)).hidden && (await A.page.evaluate(() => document.getElementById('keo-enroll').textContent.length)) > 0 && (await A.page.evaluate(() => document.querySelector('#keo-enroll textarea:not([readonly])').value)) === '');
    const soon = await op(A.frame, 'enroll.open', { mode: 'old' });
    check('A: the world asking again right after is refused, so it cannot keep the question up', !soon.ok && /closed a moment ago/.test(soon.e), soon);
    // B closes: the page reloads (a marker set on the page is gone afterwards). A start.html#guest page never resumes a session by
    // design (keo-gate.js), so the check that the session survived is made on the address a person would use, in the same tab.
    const nDialogs = dialogsB.length;
    await B.page.evaluate(() => { window.__beforeClose = 1; });
    await B.page.click(NO);
    const reloaded = await poll(() => B.page.evaluate(() => window.__beforeClose === undefined), 15000);
    check('B: closing it raised no browser "Leave site?" warning', dialogsB.length === nDialogs, dialogsB.slice(nDialogs));
    check('B: closing the dialog after the webputer was linked reloads the page', !!reloaded);
    await B.page.goto(`chrome-extension://${ID_B}/start.html`);
    const after = await poll(() => shell(B.page, async () => { const c = await window.keoIdentity.current(); return c && c.did; }).then((x) => x.r), 15000);
    check('B: and on a normal start it is still signed in as the identity', after === DID, after);
    // ... and a person signed in with nothing saved lands on their own home page (homestar), as after any sign-in.
    const landed = await poll(async () => { const fr = await waitForWorld(B.page); return fr.evaluate(() => { const s = window.keo && keo.init && keo.init.startup; return s && s.kind ? { kind: s.kind, label: s.session && s.session.label } : null; }); }, 20000);
    check('B: a normal start lands on the home page of the identity, signed in under the name given while linking', !!landed && landed.kind === 'homestar' && landed.label === 'Alice desktop', landed);
    await B.page.goto(`chrome-extension://${ID_B}/start.html#guest`);

    // ---- a request that is never answered is dropped with the dialog
    const B2 = await op((await waitForWorld(B.page)), 'enroll.open', { mode: 'new' });
    check('B: on a fresh page the dialog can be asked for again', B2.ok, B2);
    await B.page.click(NO);
    const cancelled = await shell(B.page, () => window.keoIdentity.enrollComplete({ grant: { v: 1, kind: 'enroll-grant', event: {}, authority: {}, sealed: 'x', iv: 'x', ecdh: {} }, confirm: '' }));
    check('B: with nothing waiting, no grant can be completed', !cancelled.ok && /No request is waiting/.test(cancelled.err), cancelled);
  } catch (e) {
    failed++; console.log('FAIL the test crashed: ' + (e && e.stack || e));
  } finally {
    // each context is closed by its own handle: nothing is stopped by name
    await A.ctx.close().catch(() => {}); await B.ctx.close().catch(() => {});
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
