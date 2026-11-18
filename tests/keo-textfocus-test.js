// A text field that gets focus puts back the selection saved before the focus, one tick later (Text>>onFocus). That range can be long
// stale (a field first clicked while it was empty keeps [0,0]) and the tick can come late, behind a run of key events; a restore that
// lands after the first key has gone in moves the caret to the start of the field or collapses a select-all, so a name typed over the
// old text ended up in front of it ("Fresh startTrip") or after its own first letters ("resh startF"). A key pressed before the tick
// must cancel the restore; a focus with no key before the tick must restore as before.
// Usage: node keo-textfocus-test.js <repo root> <extension folder> <work dir>
// Not a race: the key is sent in the same task as the focus, so the tick cannot have run yet. That makes it fail on a build without the
// change every time, and pass with it. The last check types with real keys over a stale range, five times; it is an end-to-end guard
// that typing still works, NOT a test of the change (without the change it passes most of the time, the tick being usually early).
// A headed browser with the extension loaded, `localhost` unresolvable, a virtual authenticator (the guest world needs none, it is
// there like in the other tests). NOT covered: a mouse click as the way the focus arrives (the restore still runs after a click).
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 700) : '')); }

const worldFrame = (page) => page.frames().find((f) => /world\.html$/.test(f.url()));
async function waitForWorld(page, kind) {
  for (let i = 0; i < 200; i++) {
    const f = worldFrame(page);
    if (f) { try { if (await f.evaluate((k) => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind === k), kind)) { await sleep(2500); return f; } } catch (e) {} }
    await sleep(300);
  }
  throw new Error('the world did not start as ' + kind);
}

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
    // a one-line field holding "Trip", made the way the Create page of "My worlds" makes its name field
    await frame.evaluate(() => { const t = new lively.morphic.Text(lively.rect(40, 100, 240, 26), 'Trip'); t.name = 'focusTestField'; t.beInputLine(); $world.addMorph(t); window.__t = t; });
    check('setup: the field is there and holds Trip', (await frame.evaluate(() => String(window.__t.textString))) === 'Trip');

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
    await sleep(200);
    const after = await frame.evaluate(() => ({ range: window.__t.getSelectionRange(), text: String(window.__t.textString) }));
    check('stale range: the tick that comes after the key does not collapse the select-all', Array.isArray(after.range) && after.range[0] === 0 && after.range[1] === 4, after);
    check('stale range: the pending restore was marked, and the key cancelled it', a.waiting === true && a.cancelledByTheKey === true, a);

    // ---- no key before the tick: the restore is made as it always was
    await frame.evaluate(() => { const t = window.__t; t.blur(); t.priorSelectionRange = [1, 3]; t.focus(); });
    await sleep(200);
    const restored = await frame.evaluate(() => ({ range: window.__t.getSelectionRange(), pending: !!window.__t.constructor.prototype.pendingFocusRestore }));
    check('no key: the saved range is put back as before (1 to 3)', Array.isArray(restored.range) && restored.range[0] === 1 && restored.range[1] === 3, restored);
    check('no key: nothing is left pending afterwards', restored.pending === false, restored);

    // ---- nothing new is kept on the morph, so nothing new is saved into a world
    const own = await frame.evaluate(() => ({ own: Object.prototype.hasOwnProperty.call(window.__t, 'pendingFocusRestore'), keys: Object.keys(window.__t).filter((k) => /pending/i.test(k)) }));
    check('the pending mark is not a property of the field (it is on the prototype, like the active text)', own.own === false && own.keys.length === 0, own);

    // ---- end to end, with real keys over a stale range (a guard that typing still works; see the top of this file)
    const typed = [];
    for (let i = 0; i < 5; i++) {
      // charsTyped is emptied as a click on the field would (Text>>onMouseUp): while it holds what was typed before, Ctrl+A selects only that
      // "recent typing", not the whole text, and the check would be about that and not about the restore.
      await frame.evaluate(() => { const t = window.__t; t.setTextString('Trip'); t.charsTyped = ''; t.blur(); t.priorSelectionRange = [0, 0]; });
      await sleep(150);
      await frame.evaluate(() => window.__t.focus());
      await page.keyboard.press('Control+A'); await page.keyboard.type('F'); await page.keyboard.type('resh start', { delay: 10 });
      await sleep(250);
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
