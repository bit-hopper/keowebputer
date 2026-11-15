// A DIAGNOSTIC, not a test: opens the wiki editor (and its index and history) in a built keo package and writes down what happens, step by
// step, with the dev server unreachable. It decides nothing and asserts nothing: it answers "does the wiki editor run in a keo build as it
// is, and what does it ask a server for?". Like keo-features-probe.js it does not end in -test.
// Usage: [KEO_HEADLESS=1] [KEO_SIGNED_IN=1] node tests/keo-wiki-probe.js <repo root> <package folder> <work dir>
// KEO_SIGNED_IN=1 makes an identity with a virtual authenticator and signs in first (the editor then runs in a signed-in world); without
// it the world is the guest world and the editor says "Not signed in" and tries nothing.
// Writes <work dir>/wiki-probe.json and a screenshot per step. The browser is headed and takes the foreground for about a minute, unless
// KEO_HEADLESS=1: then it runs in the browser's newer headless mode (no window, no focus taken, extensions still load). That is NOT how
// the other browser tests run, so a result from it says so (report.mode) and anything that looks focus-dependent should be rerun headed.
const path = require('path');
const fs = require('fs');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (u) => String(u).replace(/^chrome-extension:\/\/[a-p]+\//, '<pkg>/');

(async () => {
  const hardStop = setTimeout(() => { console.error('HARD STOP: the probe ran over four minutes'); process.exit(3); }, 240000);
  const profile = path.join(WORK, 'profile-wiki-' + process.pid);
  const headless = !!process.env.KEO_HEADLESS;
  const ctx = await chromium.launchPersistentContext(profile, Object.assign({ headless: headless, viewport: { width: 1400, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] }, headless ? { channel: 'chromium' } : {}));
  const report = { startedAt: new Date().toISOString(), package: path.basename(EXT), mode: headless ? 'headless (new mode, channel chromium)' : 'headed', browserVersion: ctx.browser() ? ctx.browser().version() : null, steps: [] };
  try {
    await sleep(2500);
    const page = await ctx.newPage();
    let bucket = null;
    const note = (kind, s) => { if (bucket) bucket.push(kind + ' ' + s); };
    page.on('request', (r) => { if (bucket && !/^(chrome-extension|data|blob):/.test(r.url())) note('REQUEST', r.method() + ' ' + r.url().slice(0, 160)); });
    page.on('requestfailed', (r) => note('REQFAIL', r.method() + ' ' + short(r.url()).slice(0, 160) + ' ' + ((r.failure() || {}).errorText || '')));
    page.on('response', (r) => { if (r.status() >= 400) note('HTTP' + r.status(), short(r.url()).slice(0, 160)); });
    page.on('websocket', (w) => note('WEBSOCKET', w.url().slice(0, 160)));
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/compute-pressure/.test(m.text())) note('console.' + m.type(), m.text().slice(0, 400).replace(/\n/g, ' ')); });
    page.on('pageerror', (e) => note('PAGEERROR', e.message.slice(0, 300)));

    // KEO_SIGNED_IN=1: a virtual authenticator makes an identity and signs in (as keo-session-test.js does), so the editor runs in a
    // signed-in world; without it the world is the guest world and the editor says "Not signed in".
    const signedIn = !!process.env.KEO_SIGNED_IN;
    report.signedIn = signedIn;
    let frame;
    const findWorld = async () => {
      let f = null;
      for (let i = 0; i < 100 && !f; i++) { f = page.frames().find((x) => /world\.html$/.test(x.url())); await sleep(200); }
      for (let i = 0; i < 150; i++) { try { if (await f.evaluate(() => !!(window.$world && window.$world.submorphs))) break; } catch (e) { /* the frame is still loading */ } await sleep(300); }
      await sleep(1500);
      return f;
    };
    if (!signedIn) {
      await page.goto(`chrome-extension://${ID}/start.html#guest`);
      frame = await findWorld();
    } else {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('WebAuthn.enable', { enableUI: false });
      await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
      await page.goto(`chrome-extension://${ID}/start.html`);
      frame = await findWorld();
      report.createIdentity = await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }).then((r) => ({ ok: true, did: r && r.did }), (e) => ({ ok: false, error: String(e && e.message || e) })));
      if (!report.createIdentity.ok) throw new Error('could not make an identity: ' + report.createIdentity.error);
      await frame.evaluate(() => window.keo.call('world.go', { kind: 'enter' }, 60000)).catch(() => { /* the frame is replaced while this answers */ });
      for (let i = 0; i < 200; i++) {
        const f = page.frames().find((x) => /world\.html$/.test(x.url()));
        try { if (f && await f.evaluate(() => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind === 'homestar'))) { frame = f; break; } } catch (e) { /* not yet */ }
        await sleep(300);
      }
      await sleep(2500);
      report.startup = await frame.evaluate(() => JSON.stringify(window.keo.init.startup).slice(0, 300)).catch(() => null);
    }

    const step = async (name, fn, wait) => {
      bucket = [];
      const t0 = Date.now();
      let result;
      try { result = await fn(); } catch (e) { result = { threw: String(e).slice(0, 400) }; }
      await sleep(wait === undefined ? 2500 : wait);
      const entry = { step: name, result, ms: Date.now() - t0, events: Array.from(new Set(bucket)).slice(0, 60) };
      report.steps.push(entry);
      try { await page.screenshot({ path: path.join(WORK, (signedIn ? 'wikisi-' : 'wiki-') + String(report.steps.length).padStart(2, '0') + '-' + name + '.png') }); } catch (e) { /* the page may be gone */ }
      console.log('== ' + name + ' (' + entry.ms + ' ms): ' + JSON.stringify(result).slice(0, 700));
      entry.events.slice(0, 40).forEach((l) => console.log('     ' + l));
      return result;
    };
    const inWorld = (src) => frame.evaluate(new Function('return (async () => {' + src + '})()'));
    // what the editor window shows, read from the morph and its DOM
    const SNAP = `
      const ed = window.__ed; if (!ed) return { noEditor: true };
      const root = ed.renderContext && ed.renderContext().shapeNode;
      const buttons = root ? Array.from(root.querySelectorAll('button, [role=button]')).map((b) => (b.textContent || b.title || '').trim()).filter(Boolean).slice(0, 40) : null;
      return { hasView: !!ed.editorView, hasYDoc: !!ed.yDoc, canEdit: ed._canEdit, isOwner: ed._isOwner, isNew: ed._isNew, objId: ed._objId, hasWsProvider: !!ed.wsProvider,
        text: ed.editorView ? ed.editorView.state.doc.textContent.slice(0, 200) : null,
        yjsFragment: ed.yDoc ? ed.yDoc.getXmlFragment('prosemirror').toString().slice(0, 300) : null,
        visibleText: root ? (root.innerText || '').replace(/\\s+/g, ' ').slice(0, 500) : null, buttons: buttons };`;

    await step('environment', () => inWorld(`
      window.__cred = [];
      const c = navigator.credentials; const out = { credentialsApi: typeof c, publicKeyCredential: typeof window.PublicKeyCredential, secure: window.isSecureContext, origin: location.origin, href: location.href };
      if (c) for (const m of ['get', 'create']) { const orig = c[m] && c[m].bind(c); if (orig) c[m] = function () { window.__cred.push(m); return orig.apply(null, arguments); }; }
      try { out.currentUser = JSON.stringify(lively.identity.did.currentUser()); } catch (e) { out.currentUserThrew = String(e).slice(0, 160); }
      try { out.baseUrl = lively.identity.did.baseUrl(); } catch (e) { out.baseUrlThrew = String(e).slice(0, 160); }
      out.localIdentity = typeof lively.identity.localIdentity;
      try { out.localIdentityKeys = Object.keys(lively.identity.localIdentity || {}).slice(0, 40); } catch (e) { out.localIdentityKeysThrew = String(e).slice(0, 120); }
      try { out.keoSession = JSON.stringify(window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.session).slice(0, 200); } catch (e) { /* no session */ }
      return out;`), 500);

    await step('load-module', () => inWorld(`
      await new Promise((r) => lively.require('lively.identity.WikiEditor').toRun(r));
      return { newCard: typeof lively.identity.WikiEditor.newCard, openCard: typeof lively.identity.WikiEditor.openCard };`), 1500);

    await step('new-page', () => inWorld(`
      window.__ed = lively.identity.WikiEditor.newCard('probe', { wikiName: 'probe-page' });
      await new Promise((r) => setTimeout(r, 4000));
      ${SNAP}`), 1500);

    // in a signed-in world the home page fills the screen and the editor window opens BEHIND it: bring it to the front so the clicks below land
    await step('bring-to-front', () => inWorld(`
      const ed = window.__ed; if (!ed || !ed.owner) return { noEditor: true };
      const owner = ed.owner; owner.addMorph(ed);
      return { ownerIs: owner === $world ? 'the world' : 'another morph', indexInOwner: owner.submorphs.indexOf(ed), of: owner.submorphs.length };`), 800);

    await step('runtime-globals', () => inWorld(`
      return { Y: typeof window.Y, prosemirror: typeof window.ProseMirror, yProsemirror: typeof window.yProsemirror || typeof window.Y_PROSEMIRROR, websocketProvider: typeof window.WebsocketProvider,
        runtimeScript: !!Array.from(document.scripts).find((s) => /postcard-runtime/.test(s.src)), katexCss: !!document.getElementById('katex-css') };`), 300);

    await step('type-text', async () => {
      const box = frame.locator('.ProseMirror').first();
      await box.click({ timeout: 8000 });
      await page.keyboard.type('Hello from the wiki probe', { delay: 25 });
      await sleep(600);
      return inWorld(SNAP);
    }, 1500);

    await step('autosave-wait', async () => { await sleep(6000); return inWorld(SNAP); }, 500);

    await step('save-button', async () => {
      const labels = await inWorld(`return window.__ed && window.__ed.renderContext ? Array.from(window.__ed.renderContext().shapeNode.querySelectorAll('button, [role=button]')).map((b) => (b.textContent || b.title || '').trim()).filter(Boolean) : null;`);
      const save = frame.locator('button', { hasText: /^\s*(save|save page)\s*$/i }).first();
      let clicked = false;
      try { await save.click({ timeout: 3000 }); clicked = true; } catch (e) { /* no such button */ }
      await sleep(6000);
      const after = await inWorld(SNAP);
      const cred = await inWorld('return window.__cred;');
      return { buttons: labels, clickedSave: clicked, passkeyCallsFromWorldFrame: cred, after };
    }, 500);

    await step('history', async () => {
      const hist = frame.locator('button', { hasText: /history/i }).first();
      let clicked = false;
      try { await hist.click({ timeout: 3000 }); clicked = true; } catch (e) { /* no such button */ }
      await sleep(4000);
      return { clickedHistory: clicked, morphsNow: await inWorld('return $world.submorphs.length;') };
    }, 500);

    // call the serializer (what Save runs first) directly, to see exactly where it stops and why
    await step('serialize-direct', () => inWorld(`
      await new Promise((r) => lively.require('lively.identity.WikiSerializer').toRun(r));
      const ed = window.__ed;
      const out = { user: null };
      try { const u = lively.identity.did.currentUser(); out.user = u ? { keys: Object.keys(u), hasDocument: !!u.document, hasCredentialId: !!u.credentialId, hasRpId: !!u.rpId, local: u.local } : null; } catch (e) { out.userThrew = String(e); }
      const res = await new Promise((resolve) => {
        const t = setTimeout(() => resolve({ timedOut: true }), 8000);
        try {
          lively.identity.wikiSerializer.serializeToEnvelope({ prevEnvelope: null, constellation: null, wikiName: 'probe-page', yDoc: ed.yDoc, attachments: [], stateMeta: {} },
            (err, env) => { clearTimeout(t); resolve({ err: err ? { message: err.message || String(err), stack: String(err.stack || '').split('\\n').slice(0, 5).join(' | ') } : null, envelope: !!env }); });
        } catch (e) { clearTimeout(t); resolve({ threw: String(e), stack: String(e.stack || '').split('\\n').slice(0, 5).join(' | ') }); }
      });
      out.serialize = res; out.passkeyCalls = window.__cred;
      return out;`), 500);

    await step('open-existing-page', () => inWorld(`
      window.__ed = lively.identity.WikiEditor.openCard('probe', 'no-such-page');
      await new Promise((r) => setTimeout(r, 5000));
      ${SNAP}`), 500);

    await step('wiki-index', () => inWorld(`
      await new Promise((r) => lively.require('lively.identity.WikiIndex').toRun(r));
      lively.identity.WikiIndex.open('probe');
      await new Promise((r) => setTimeout(r, 5000));
      return { morphs: $world.submorphs.length, windows: $world.submorphs.map((m) => m.constructor && m.constructor.type || m.name || '?').slice(-8) };`), 500);

    report.finishedAt = new Date().toISOString();
  } finally {
    const out = path.join(WORK, process.env.KEO_SIGNED_IN ? 'wiki-probe-signed-in.json' : 'wiki-probe.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    await ctx.close().catch(() => {});
    clearTimeout(hardStop);
    console.log('report: ' + out);
  }
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
