// A text field that gets focus puts back the selection saved before the focus, one tick later (Text>>onFocus). That range can be long
// stale (a field first clicked while it was empty keeps [0,0]) and the tick can come late, behind a run of key events; a restore that
// lands after the first key has gone in moves the caret to the start of the field or collapses a select-all, so a name typed over the
// old text ended up in front of it ("Fresh startTrip") or after its own first letters ("resh startF"). And a restore that lands after
// the focus has moved to another field focuses the first field again (setSelectionRange focuses a text that is not focused). So a key
// pressed, or the focus leaving, before the tick must cancel the restore; a focus with neither before the tick must restore as before.
// Usage: node keo-textfocus-test.js <repo root> <extension folder> <work dir>
// Not a race: the key (or the second focus) comes in the same task as the first focus, so the tick cannot have run yet. That makes the
// checks fail on a build without the change every time, and pass with it. Nothing waits by sleeping: an effect that should appear is
// polled for, and a tick that must already have run is waited for with a timer of the test's own queued behind it (timers of equal delay
// run in the order they were queued), so a slow machine cannot make a check pass or fail by timing. The last check types with real
// keys over a stale range, five times; it is an end-to-end guard that typing still works, NOT a test of the change (without the change
// it passes most of the time, the tick being usually early).
// A click into a field is the other way a focus arrives: the browser puts the caret where the click was made and focuses the field, and the
// range saved by an earlier click must not be put back over it a tick later. Text>>onMouseDown drops the saved range when the press is about
// to focus the text. The click checks use real mouse presses (a control that has no saved range, then the case itself) and the same timer
// barrier as above.
// A headed browser with the extension loaded, `localhost` unresolvable (the guest world needs no identity). NOT covered: a focus that leaves
// because the whole window loses it, and a click on a field that cannot take the focus.
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 700) : '')); }
async function until(fn, ms) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > (ms || 5000)) return v; await sleep(100); } }

const worldFrame = (page) => page.frames().find((f) => /world\.html$/.test(f.url()));
async function waitForWorld(page, kind) {
  for (let i = 0; i < 200; i++) {
    const f = worldFrame(page);
    if (f) { try { if (await f.evaluate((k) => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind === k), kind)) { await sleep(2500); return f; } } catch (e) {} }
    await sleep(300);
  }
  throw new Error('the world did not start as ' + kind);
}
// Resolves when every timer queued before this call has run: one of its own goes in behind them, twice, so a tick that a tick queues is
// covered too.
const afterTicks = (frame) => frame.evaluate(() => new Promise((res) => setTimeout(() => setTimeout(res, 0), 0)));
const rangeOf = (frame, which) => frame.evaluate((w) => window[w].getSelectionRange(), which);

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-textfocus'), {
    headless: false, viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2000);
  try {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${ID}/start.html#guest`);
    const frame = await waitForWorld(page, 'guest');
    // two one-line fields, made the way the Create page of "My worlds" makes its name field; __t holds Trip
    await frame.evaluate(() => {
      const mk = (text, y) => { const t = new lively.morphic.Text(lively.rect(40, y, 240, 26), text); t.beInputLine(); $world.addMorph(t); return t; };
      window.__t = mk('Trip', 100); window.__t.name = 'focusTestField';
      window.__other = mk('Other', 160); window.__other.name = 'focusTestOther';
    });
    check('setup: the field is there and holds Trip', (await frame.evaluate(() => String(window.__t.textString))) === 'Trip');
    await afterTicks(frame);

    // ---- a key pressed before the tick keeps what it did
    // The saved range is the stale one; focus() runs onFocus at once (the restore now waits for its tick); a select-all goes in at once,
    // in the same task, so the tick has not run. Then the tick runs.
    const a = await frame.evaluate(() => {
      const t = window.__t, node = t.renderContext().textNode;
      t.blur(); t.priorSelectionRange = [0, 0];
      t.focus();
      const waiting = !!t.constructor.prototype.pendingFocusRestore;
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', keyCode: 65, which: 65, ctrlKey: true, bubbles: true, cancelable: true }));
      return { focused: t.isFocused(), waiting, cancelledByTheKey: !t.constructor.prototype.pendingFocusRestore, range: t.getSelectionRange() };
    });
    check('stale range: the focus is on the field and the select-all took effect at once', a.focused && Array.isArray(a.range) && a.range[0] === 0 && a.range[1] === 4, a);
    await afterTicks(frame);
    const after = await frame.evaluate(() => ({ range: window.__t.getSelectionRange(), text: String(window.__t.textString) }));
    check('stale range: the tick that comes after the key does not collapse the select-all', Array.isArray(after.range) && after.range[0] === 0 && after.range[1] === 4, after);
    check('stale range: the pending restore was marked, and the key cancelled it', a.waiting === true && a.cancelledByTheKey === true, a);

    // ---- the focus leaves before the tick: the restore is for a field that has no focus now, and must not take it back
    const d = await frame.evaluate(() => {
      const t = window.__t, o = window.__other;
      t.blur(); o.blur(); t.priorSelectionRange = [0, 0];
      t.focus();                                  // the restore for t waits for its tick
      const waiting = !!t.constructor.prototype.pendingFocusRestore;
      o.focus();                                  // the focus moves on in the same task
      return { waiting, holder: t.isFocused() ? 't' : o.isFocused() ? 'other' : 'none', pendingAfterMove: !!t.constructor.prototype.pendingFocusRestore };
    });
    await afterTicks(frame);
    const dLater = await frame.evaluate(() => ({ holder: window.__t.isFocused() ? 't' : window.__other.isFocused() ? 'other' : 'none',
      domFocusInOther: window.__other.renderContext().textNode.contains(document.activeElement), domFocusInT: window.__t.renderContext().textNode.contains(document.activeElement) }));
    check('focus moves on: the focus is on the field that has it after the tick, not taken back', d.waiting === true && d.holder === 'other' && dLater.holder === 'other' && dLater.domFocusInOther && !dLater.domFocusInT, { d, dLater });
    check('focus moves on: nothing is left pending', d.pendingAfterMove === false, d);

    // ---- neither a key nor a focus change before the tick: the restore is made as it always was
    await frame.evaluate(() => { const t = window.__t; t.blur(); t.priorSelectionRange = [1, 3]; t.focus(); });
    const restored = await until(async () => { const r = await rangeOf(frame, '__t'); return Array.isArray(r) && r[0] === 1 && r[1] === 3 ? r : null; });
    check('no key, no move: the saved range is put back as before (1 to 3)', !!restored, await rangeOf(frame, '__t'));
    check('no key, no move: nothing is left pending afterwards', (await frame.evaluate(() => !!window.__t.constructor.prototype.pendingFocusRestore)) === false);

    // ---- a click into a field is the other way a focus arrives, and there the caret goes where the click was made
    // The browser puts the caret at the click and focuses the field; the range saved by an earlier click must not be put back over it. These are real
    // mouse presses. The check that needs the tick to have run waits for it with a timer of the test's own queued behind it, not with a sleep. A press that
    // lasts 50 ms is what a hand does (the press length is not what the checks wait on).
    const off = await (await frame.frameElement()).boundingBox();      // the world frame's place in the page: frame coordinates to page coordinates
    await frame.evaluate(() => { const t = new lively.morphic.Text(lively.rect(40, 230, 380, 26), 'alpha beta gamma delta'); t.beInputLine(); t.name = 'focusTestClick'; $world.addMorph(t); window.__c = t; });
    await afterTicks(frame);
    // the page position of the boundary before character i of the field's text (a collapsed range's rectangle)
    const boundary = async (i) => {
      const b = await frame.evaluate((idx) => {
        const node = window.__c.renderContext().textNode, w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let rem = idx, n, tn = null, o = 0;
        while ((n = w.nextNode())) { if (rem <= n.length) { tn = n; o = rem; break; } rem -= n.length; }
        if (!tn) return null;
        const r = document.createRange(); r.setStart(tn, o); r.collapse(true); const rc = r.getBoundingClientRect(); return { x: rc.left, y: (rc.top + rc.bottom) / 2 };
      }, i);
      return b && { x: off.x + b.x, y: off.y + b.y };
    };
    const press = async (p) => { await page.mouse.move(p.x, p.y); await page.mouse.click(p.x, p.y, { delay: 50 }); };
    const len = await frame.evaluate(() => String(window.__c.textString).length), mid = 6;      // "alpha |beta ..."
    const pMid = await boundary(mid), pEnd = await boundary(len);
    check('click setup: the field holds the text and both click points are found', len === 22 && !!pMid && !!pEnd, { len, pMid, pEnd });
    // control: a field that has never been clicked has no saved range, so this shows the click geometry and the caret reading are right
    await press(pMid); await afterTicks(frame);
    check('click control: a click into a field never clicked before puts the caret where it was made (6)', JSON.stringify(await rangeOf(frame, '__c')) === JSON.stringify([mid, mid]), await rangeOf(frame, '__c'));
    // the case itself: a range saved at the end by a click, the field blurs, then a click in the middle
    await press({ x: pEnd.x + 1, y: pEnd.y });
    const savedEnd = await until(async () => { const r = await frame.evaluate(() => window.__c.priorSelectionRange || null); return r && r[0] === len && r[1] === len ? r : null; }, 3000);
    await frame.evaluate(() => window.__c.blur());
    const blurred = await frame.evaluate(() => ({ focused: window.__c.isFocused(), prior: window.__c.priorSelectionRange || null }));
    check('click setup: the field has a saved range at its end and no focus', !!savedEnd && blurred.focused === false && Array.isArray(blurred.prior) && blurred.prior[0] === len, { savedEnd, blurred });
    await press(pMid); await afterTicks(frame);
    const landed = await frame.evaluate(() => ({ range: window.__c.getSelectionRange(), focused: window.__c.isFocused(), pending: !!window.__c.constructor.prototype.pendingFocusRestore }));
    check('click: a click into a field that has a saved range puts the caret where it was made (6), not at the old place', Array.isArray(landed.range) && landed.range[0] === mid && landed.range[1] === mid && landed.focused, landed);
    check('click: nothing is left pending after the click', landed.pending === false, landed);

    // ---- nothing new is kept on the morph, so nothing new is saved into a world
    const own = await frame.evaluate(() => ({ own: Object.prototype.hasOwnProperty.call(window.__t, 'pendingFocusRestore'), keys: Object.keys(window.__t).filter((k) => /pending/i.test(k)) }));
    check('the pending mark is not a property of the field (it is on the prototype, like the active text)', own.own === false && own.keys.length === 0, own);

    // ---- end to end, with real keys over a stale range (a guard that typing still works; see the top of this file)
    const typed = [];
    for (let i = 0; i < 5; i++) {
      // charsTyped is emptied as a click on the field would (Text>>onMouseUp): while it holds what was typed before, Ctrl+A selects only that
      // "recent typing", not the whole text, and the check would be about that and not about the restore.
      await frame.evaluate(() => { const t = window.__t; t.setTextString('Trip'); t.charsTyped = ''; t.blur(); t.priorSelectionRange = [0, 0]; });
      await afterTicks(frame);
      await frame.evaluate(() => window.__t.focus());
      await page.keyboard.press('Control+A'); await page.keyboard.type('F'); await page.keyboard.type('resh start', { delay: 10 });
      await until(async () => (await frame.evaluate(() => String(window.__t.textString))) === 'Fresh start', 3000);
      typed.push(await frame.evaluate(() => String(window.__t.textString)));
    }
    check('typing over the old text with real keys, five times, gives "Fresh start" each time', typed.every((x) => x === 'Fresh start'), typed);
  } catch (e) {
    check('test ran to the end', false, String(e && e.stack || e));
  } finally {
    await ctx.close().catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
