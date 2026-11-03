// The overlay: files stored in the shell replace the package's own when the world starts (the mechanism updates will use).
// Writes two overlay entries by hand (the way the updater will, after verifying a release), restarts the world and checks that
// the world ran the overlaid code through each way the kernel loads code, that the world cannot write or replace the overlay,
// and that clearing it returns to the package.
// Usage: node keo-overlay-test.js <repo root> <extension folder> <work dir>
const path = require('path');
const fs = require('fs');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(path.resolve(REPO), 'node_modules', 'playwright-core'));
const ID = 'cgjphijackijgcjkfdfieihkbfooigjp', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 700) : '')); }
const MODULE = 'core/lively/identity/LocalIdentity.js';      // loaded on demand, not part of the boot bundle
const rd = (rel) => fs.readFileSync(path.join(EXT, rel), 'utf8');
(async () => {
  const hash = rd('generated/combinedModulesHash.txt').trim(), BUNDLE = 'generated/' + hash + '/combinedModules.js';
  const files = {
    [MODULE]: rd(MODULE) + "\n;window.__scriptProbe = 'script';\n",
    [BUNDLE]: rd(BUNDLE) + "\n;window.__bundleProbe = 'bundle';\n"
  };
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-overlay-' + process.pid), { headless: false, viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure/.test(m.text())) errors.push(m.text().slice(0, 300) + ' @' + ((m.location() || {}).url || '')); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 300)));
  async function start() {
    // a second goto to the same address with a fragment is NOT a reload, so restart the page itself when it is already open
    if (/^chrome-extension:/.test(page.url())) await page.reload(); else await page.goto(`chrome-extension://${ID}/start.html#guest`);
    let frame; for (let i = 0; i < 100 && !frame; i++) { frame = page.frames().find((f) => /world\.html$/.test(f.url())); await sleep(200); }
    for (let i = 0; i < 150; i++) { try { if (await frame.evaluate(() => !!(window.$world && window.$world.submorphs))) break; } catch (e) {} await sleep(300); }
    await sleep(1000);
    return frame;
  }
  const probe = (frame) => frame.evaluate(() => new Promise((res) => {
    const out = { bundle: window.__bundleProbe, overlayKeys: Object.keys((window.keo.init || {}).overlay || {}) };
    const t = setTimeout(() => res(Object.assign(out, { timeout: true })), 20000);
    const tagOf = (re, probe) => { const el = Array.prototype.find.call(document.getElementsByTagName('script'), (s) => re.test(s.id || s.getAttribute('src') || '')); return el ? { hasSrcAttr: el.getAttribute('src') !== null, inline: probe.test(el.textContent) } : null; };
    out.bundleTag = tagOf(/combinedModules/, /__bundleProbe/);
    lively.require('lively.identity.LocalIdentity').toRun(function () {
      clearTimeout(t);
      // this callback runs inside the module's own code, before the marker line appended after it has executed
      setTimeout(function () {
        out.script = window.__scriptProbe; out.moduleLoaded = !!(lively.identity && lively.identity.localIdentity);
        out.tag = tagOf(/LocalIdentity\.js/, /__scriptProbe/);
        res(out);
      }, 300);
    });
  }));

  // ---- 1. control: no overlay, the package alone ----
  let frame = await start();
  const base = await probe(frame);
  check('control: no overlay keys, no probes, the module loads', base.overlayKeys.length === 0 && base.bundle === undefined && base.script === undefined && base.moduleLoaded, base);

  // ---- 2. overlay written by the shell side (what the updater does after verifying), world restarted ----
  await page.evaluate(async (f) => { for (const k of Object.keys(f)) await window.keoOverlay.put(k, f[k]); }, files);
  frame = await start();
  const p = await probe(frame);
  check('overlay: the world received both entries in the handshake', p.overlayKeys.length === 2 && p.overlayKeys.includes(MODULE) && p.overlayKeys.includes(BUNDLE), p);
  check('overlay: the boot bundle ran the overlaid text', p.bundle === 'bundle', p);
  check('overlay: an on-demand module ran the overlaid text', p.script === 'script' && p.moduleLoaded, p);
  const how = (t, what) => t ? (t.hasSrcAttr ? 'script tag with src (NOT overlaid)' : t.inline ? 'script tag, inline overlay text' : 'script tag without the probe') : 'no script tag (fetch or XHR, then eval)';
  console.log('INFO the bundle was loaded by: ' + how(p.bundleTag) + '; the on-demand module by: ' + how(p.tag));

  const viaXhr = await frame.evaluate((m) => { const x = new XMLHttpRequest(); x.open('GET', m + '?t=123', false); x.send(null); return { status: x.status, hasProbe: /__scriptProbe/.test(x.responseText) }; }, MODULE);
  check('overlay: a synchronous XHR (with a cache-buster query) reads the overlaid text', viaXhr.status === 200 && viaXhr.hasProbe, viaXhr);
  const viaAsync = await frame.evaluate((m) => new Promise((res) => { const x = new XMLHttpRequest(); x.onload = () => res({ status: x.status, hasProbe: /__scriptProbe/.test(x.responseText) }); x.onerror = () => res({ error: true }); x.open('GET', m); x.send(null); }), MODULE);
  check('overlay: an asynchronous XHR reads the overlaid text', viaAsync.status === 200 && viaAsync.hasProbe, viaAsync);
  const viaFetch = await frame.evaluate((m) => fetch(m).then((r) => r.text().then((t) => ({ status: r.status, type: r.headers.get('content-type'), hasProbe: /__scriptProbe/.test(t) }))), MODULE);
  check('overlay: fetch reads the overlaid text with a script content type', viaFetch.status === 200 && viaFetch.hasProbe && /javascript/.test(viaFetch.type), viaFetch);
  const other = await frame.evaluate(() => fetch('core/lively/Helper.js').then((r) => r.text().then((t) => ({ status: r.status, len: t.length, probe: /__scriptProbe|__bundleProbe/.test(t) }))));
  check('overlay: a file that is not overlaid still comes from the package', other.status === 200 && other.len > 100 && !other.probe, other);

  // ---- 3. the world can not write or replace the overlay ----
  const ops = await frame.evaluate(() => Promise.all(['overlay.put', 'overlay.all', 'overlay.clear'].map((op) =>
    window.keo.call(op, { path: 'core/lively/Helper.js', text: 'EVIL' }).then(() => op + ' answered', (e) => /unknown op/.test(e.message) ? 'refused' : 'error: ' + e.message))));
  check('boundary: the shell has no op that writes or reads the overlay', ops.every((x) => x === 'refused'), ops);
  const reset = await frame.evaluate((m) => { window.__keoSetOverlay({ [m]: 'EVIL' }); return fetch(m).then((r) => r.text()).then((t) => ({ evil: t === 'EVIL', hasProbe: /__scriptProbe/.test(t) })); }, MODULE);
  check('boundary: the world can not replace the overlay after start', !reset.evil && reset.hasProbe, reset);

  // ---- 4. clearing the overlay returns to the package ----
  await page.evaluate(() => window.keoOverlay.clear());
  frame = await start();
  const after = await probe(frame);
  check('rollback: after clear, no overlay keys and no probes', after.overlayKeys.length === 0 && after.bundle === undefined && after.script === undefined && after.moduleLoaded, after);

  check('no page errors', errors.length === 0, errors);
  await ctx.close();
  console.log(results.every(Boolean) ? 'ALL PASSED (' + results.length + ')' : 'FAILED: ' + results.filter((x) => !x).length);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
