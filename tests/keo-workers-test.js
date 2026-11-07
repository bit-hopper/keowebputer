// Workers inside the built extension's sandboxed world: Logo and the generic Worker wrapper's handling of non-package URLs.
// (Python is not shipped in the package, so there is no Pyodide check.)
// Usage: node keo-workers-test.js <repo root> <extension folder> <work dir>
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 700) : '')); }
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-workers-' + process.pid), { headless: false, viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure/.test(m.text())) errors.push(m.text().slice(0, 300) + ' @' + ((m.location() || {}).url || '')); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 300)));
  await page.goto(`chrome-extension://${ID}/start.html#guest`);
  let frame; for (let i = 0; i < 100 && !frame; i++) { frame = page.frames().find((f) => /world\.html$/.test(f.url())); await sleep(200); }
  for (let i = 0; i < 150; i++) { try { if (await frame.evaluate(() => !!(window.$world && window.$world.submorphs))) break; } catch (e) {} await sleep(300); }
  await sleep(1500);

  // ---- Logo: the raw worker protocol ----
  const logo = await frame.evaluate(() => new Promise((res) => {
    const out = { msgs: [] }, w = new Worker('/core/lib/logo/logo-worker.js');
    const t = setTimeout(() => res(Object.assign(out, { timeout: true })), 20000);
    w.onerror = (e) => { clearTimeout(t); res(Object.assign(out, { error: e.message || String(e) })); };
    w.onmessage = (e) => {
      out.msgs.push(e.data);
      if (e.data.op === 'init') w.postMessage({ op: 'run', id: 1, source: 'repeat 4 [fd 50 rt 90] print "hello' });
      if (e.data.op === 'done') { clearTimeout(t); w.terminate(); res(out); }
    };
    w.postMessage({ op: 'init' });
  }));
  const initMsg = logo.msgs.find((m) => m.op === 'init'), done = logo.msgs.find((m) => m.op === 'done'), draw = logo.msgs.filter((m) => m.op === 'draw');
  check('logo: worker starts and the engine loads (init ok)', initMsg && initMsg.ok, logo);
  check('logo: a program runs to done and draws', done && done.state === 'done' && draw.length > 0, logo);
  check('logo: printed text came back', JSON.stringify(logo.msgs).includes('hello'), logo);

  // ---- the wrapper leaves other URLs alone ----
  const other = await frame.evaluate(() => {
    const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })));
    return new Promise((res) => { w.onmessage = (e) => { w.terminate(); res(e.data); }; setTimeout(() => res('timeout'), 5000); });
  });
  check('worker: a blob: worker is created untouched', other === 1, other);
  check('worker: no page errors', errors.length === 0, errors);
  await ctx.close();
  console.log(results.every(Boolean) ? 'ALL PASSED (' + results.length + ')' : 'FAILED: ' + results.filter((x) => !x).length);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
