// Naming a file on a worker, in a REAL build (shell/keo-hash.js and shell/keo-hash-worker.js in the shell page of the built extension):
// the browser lets the package's worker run under the shell's own policy (script-src 'self'), it hashes there and the digest is the
// platform's; a worker file that is missing raises an error event (which is what the fallback in keo-hash.js listens for); the page's thread is held up for
// much less while a worker hashes than while the page hashes itself; shutdown stops the worker and the next file starts another.
// Usage: [KEO_HEADLESS=1] node keo-hash-page-test.js <repo root> <package folder> <work dir>
// The browser is headed unless KEO_HEADLESS=1 (then the newer headless mode: no window, no focus taken, extensions still load); the mode is
// printed first. A headless pass is not a headed pass. `localhost` is made unresolvable, so a request that still needed the dev server
// fails. One machine, one run: the timings are printed and compared with each other (same page, same bytes), never with a fixed number.
// What this does not show: the desktop app's own host (a profile script kept outside the repository runs the desktop-shaped page), a real device, the
// library's whole path (tests/keo-libfiles-test.js is that).
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const headless = !!process.env.KEO_HEADLESS;
let failed = 0, passed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 600) : '')); }

(async () => {
  const profile = path.join(WORK, 'profile-hashpage-' + process.pid);
  const ctx = await chromium.launchPersistentContext(profile, Object.assign({ headless, viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] }, headless ? { channel: 'chromium' } : {}));
  console.log('MODE ' + (headless ? 'HEADLESS (newer headless mode, channel chromium)' : 'headed') + '; browser ' + (ctx.browser() ? ctx.browser().version() : 'unknown') + '; package ' + path.basename(EXT));
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    await page.goto(`chrome-extension://${ID}/start.html`);
    await page.waitForFunction(() => !!window.keoHash && !!window.keoSha256, null, { timeout: 30000 });

    const policy = await page.evaluate(async () => (await (await fetch('manifest.json')).json()).content_security_policy);
    console.log('     (the shell page\'s policy: ' + JSON.stringify(policy.extension_pages) + ')');

    check('the page has the hash module, with no worker started yet', await page.evaluate(() => window.keoHash.stats().state === 'idle' && typeof window.keoHash.create === 'function'));

    // ---- the package's worker runs and gives the platform's digest
    const r1 = await page.evaluate(async () => {
      const fill = (n, seed) => { const u = new Uint8Array(n); let x = seed >>> 0 || 1; for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; u[i] = x & 255; } return u; };
      const hex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
      const CH = 4 * 1024 * 1024, whole = fill(3 * CH + 12345, 9), h = window.keoHash.create();      // no size given: not a "small" file
      for (let o = 0; o < whole.length; o += CH) await h.update(whole.subarray(o, Math.min(o + CH, whole.length)));
      const got = hex(await h.digest()), want = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', whole)));
      return { same: got === want, where: h.where(), stats: window.keoHash.stats(), total: whole.length };
    });
    check('the digest of 12 MiB made on the package\'s worker is the platform\'s digest', r1.same, r1);
    check('it was made on the worker, not in the page', r1.where === 'worker' && r1.stats.state === 'ready' && r1.stats.fedWorker === r1.total && r1.stats.fedLocal === 0, r1.stats);
    const small = await page.evaluate(async () => {
      const u = new Uint8Array(1000).fill(7), h = window.keoHash.create(1000); await h.update(u);
      const hex = (x) => Array.from(x, (b) => b.toString(16).padStart(2, '0')).join('');
      return { where: h.where(), same: hex(await h.digest()) === hex(new Uint8Array(await crypto.subtle.digest('SHA-256', u))) };
    });
    check('a small file is hashed in the page, with the platform\'s digest', small.where === 'local' && small.same, small);

    // ---- what the policy allows and refuses
    const probe = (src) => page.evaluate((s) => new Promise((resolve) => {
      let w;
      const done = (v) => { try { w && w.terminate(); } catch (e) { /* ignore */ } resolve(v); };
      try { w = s.kind === 'blob' ? new Worker(URL.createObjectURL(new Blob(['postMessage("ran")'], { type: 'text/javascript' }))) : new Worker(s.url); }
      catch (e) { return resolve('threw ' + e.name); }
      w.onmessage = (e) => done('ran:' + e.data);
      w.onerror = () => done('error event');
      setTimeout(() => done('nothing in 3 s'), 3000);
    }), src);
    // Printed, not asserted: whether a worker made from text may run under this policy is the browser's rule and differs between browsers
    // and versions (a guess that it would be refused was wrong in the browser this was written with). keo-hash.js does not depend on it:
    // it starts a file of the package.
    const blob = await probe({ kind: 'blob' });
    console.log('     (observed, not asserted: a worker made from a blob under this policy: ' + blob + ')');
    const missing = await probe({ kind: 'url', url: 'no-such-worker-file.js' });
    check('a worker file that is missing raises an error event (what keo-hash.js listens for)', missing === 'error event', missing);
    const own = await probe({ kind: 'url', url: 'keo-hash-worker.js' });
    check('the package\'s own worker file starts and says it is ready (its first message is an object, shown here as text)', own === 'ran:[object Object]', own);

    // ---- how long the page's thread is held up: the same 64 MiB, hashed on the worker and then in the page
    const timing = await page.evaluate(async () => {
      const fill = (n, seed) => { const u = new Uint8Array(n); let x = seed >>> 0 || 1; for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; u[i] = x & 255; } return u; };
      const CH = 4 * 1024 * 1024, data = fill(64 * 1024 * 1024, 3);
      const watch = () => {                              // longest wait for a 5 ms timer, and the stretches of 50 ms or more the browser reports
        let worst = 0, last = performance.now(), longs = [];
        const t = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; }, 5);
        const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => longs.push(Math.round(e.duration))));
        try { po.observe({ type: 'longtask', buffered: false }); } catch (e) { /* not available */ }
        return () => { clearInterval(t); po.disconnect(); return { worstGapMs: Math.round(worst), longTasks: longs }; };
      };
      await new Promise((r) => setTimeout(r, 300));
      let stop = watch(), t0 = performance.now();
      const hw = window.keoHash.create();
      for (let o = 0; o < data.length; o += CH) await hw.update(data.subarray(o, o + CH));
      const dw = await hw.digest(), onWorker = Object.assign({ ms: Math.round(performance.now() - t0) }, stop());
      await new Promise((r) => setTimeout(r, 300));
      stop = watch(); t0 = performance.now();
      const hl = window.keoSha256.create();
      for (let o = 0; o < data.length; o += CH) { hl.update(data.subarray(o, o + CH)); await new Promise((r) => setTimeout(r)); }   // a turn between chunks, as the shell has
      const dl = hl.digest(), inPage = Object.assign({ ms: Math.round(performance.now() - t0) }, stop());
      const hex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
      const want = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
      return { onWorker, inPage, workerRight: hex(dw) === want, pageRight: hex(dl) === want };
    });
    check('64 MiB: the worker and the page both give the platform digest', timing.workerRight && timing.pageRight, timing);
    console.log('     (64 MiB on the worker: ' + JSON.stringify(timing.onWorker) + ')');
    console.log('     (64 MiB in the page:   ' + JSON.stringify(timing.inPage) + ')');
    check('the page waited less for a timer while the worker hashed than while the page hashed', timing.onWorker.worstGapMs < timing.inPage.worstGapMs, timing);
    check('no stretch of 50 ms or more on the page while the worker hashed (the browser\'s own report)', timing.onWorker.longTasks.filter((d) => d >= 50).length === 0, timing.onWorker.longTasks);

    // ---- the session ends: the worker stops, the next file starts another
    const after = await page.evaluate(async () => {
      const u = new Uint8Array(1 << 20).fill(5), open = window.keoHash.create(), s0 = window.keoHash.stats();
      await open.update(u);
      window.keoHash.shutdown();
      const s1 = window.keoHash.stats(), refused = await open.update(u).then(() => 'taken', (e) => e.message);
      const next = window.keoHash.create(); await next.update(u); const d = await next.digest();
      const hex = (x) => Array.from(x, (b) => b.toString(16).padStart(2, '0')).join('');
      return { before: s0.state, afterShutdown: s1.state, refused, nextWhere: next.where(), nextState: window.keoHash.stats().state, right: hex(d) === hex(new Uint8Array(await crypto.subtle.digest('SHA-256', u))) };
    });
    check('shutdown stops the worker; a hash open then is refused; the next file starts a new worker and is named correctly',
      after.afterShutdown === 'idle' && after.refused === 'This file is no longer being named.' && after.nextWhere === 'worker' && after.nextState === 'ready' && after.right, after);

    check('the page raised no script error', errors.length === 0, errors);
  } finally {
    await ctx.close().catch(() => {});
  }
  console.log(passed + ' passed, ' + failed + ' failed (' + (headless ? 'headless' : 'headed') + ')');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED', e); process.exit(1); });
