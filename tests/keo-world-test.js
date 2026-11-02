// Load the built keo world extension and check that the Lively world boots in the sandboxed frame of start.html
// with NO dev server involved.
// Usage: node keo-world-test.js <repo root> <extension folder> <work dir>
// Checks: world exists in the frame; a Box renders; addScript works (Function.fromString path); a real mouse click
// reaches a morph's onMouseUp; what requests failed; what the shim rewrote; console errors.
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'cgjphijackijgcjkfdfieihkbfooigjp';

const FUNC = () => {
  const m = new lively.morphic.Box(lively.rect(200, 200, 220, 120));
  m.applyStyle({ fill: Color.rgb(200, 60, 60), borderWidth: 0 });
  $world.addMorph(m);
  m.addScript(function answer() { return 6 * 7; });
  m.addScript(function onMouseUp(evt) { window.__clicked = (window.__clicked || 0) + 1; return true; });
  window.__m = m;
  const r = m.renderContext().shapeNode.getBoundingClientRect();
  return { addScript: m.answer(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-world'), {
    headless: false, viewport: { width: 1280, height: 860 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      // The dev server may well be running; make it unreachable so any request that still needs it shows up as a failure.
      '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  const out = { notes: [] };
  try {
    await new Promise((r) => setTimeout(r, 2500));
    const page = await ctx.newPage();
    const errors = [], failed = [], requested = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text().slice(0, 260)); });
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e.message).slice(0, 260)));
    page.on('requestfailed', (rq) => failed.push(rq.method() + ' ' + rq.url().replace('chrome-extension://' + ID, '') + ' ' + (rq.failure() && rq.failure().errorText)));
    page.on('request', (rq) => requested.push(rq.url()));
    const t0 = Date.now();
    await page.goto(`chrome-extension://${ID}/start.html`, { timeout: 10000 });
    out.shellTitle = await page.title();
    let frame = null;
    for (let i = 0; i < 160 && !frame; i++) { frame = page.frames().find((f) => /world\.html$/.test(f.url())); if (!frame) await new Promise((r) => setTimeout(r, 250)); }
    out.frameUrl = frame && frame.url();
    let booted = null;
    while (frame && Date.now() - t0 < 60000) {
      try { if (await frame.evaluate(() => !!(window.$world && window.$world.submorphs))) { booted = Date.now() - t0; break; } } catch (e) {}
      await new Promise((r) => setTimeout(r, 400));
    }
    out.bootedMs = booted;
    if (booted) {
      await new Promise((r) => setTimeout(r, 3000));
      out.submorphs = await frame.evaluate(() => $world.submorphs.length);
      out.rewritten = await frame.evaluate(() => window.__keoRewritten || []);
      out.rootPath = await frame.evaluate(() => LivelyLoader.rootPath);
      try {
        const f = await frame.evaluate(FUNC);
        const box = await (await frame.frameElement()).boundingBox();
        await page.mouse.click(box.x + f.x, box.y + f.y);
        await new Promise((r) => setTimeout(r, 400));
        out.func = { addScript: f.addScript, clicks: await frame.evaluate(() => window.__clicked || 0) };
      } catch (e) { out.func = { err: String(e).slice(0, 300) }; }
      await page.screenshot({ path: path.join(WORK, 'keo-world.png') });
    }
    const external = requested.filter((u) => !u.startsWith('chrome-extension://') && !u.startsWith('blob:') && !u.startsWith('data:'));
    out.externalRequests = external.slice(0, 20);
    out.failed = failed.slice(0, 20);
    out.errorCount = errors.length;
    out.errors = errors.slice(0, 25);
  } finally { await ctx.close(); }
  fs.writeFileSync(path.join(WORK, 'keo-world-test.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})();
