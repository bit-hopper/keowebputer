const path = require('path');
const REPO = path.resolve(process.argv[2]), EXT = path.resolve(process.argv[3]), ID = process.argv[4];
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const PROFILE = require('path').join(require('os').tmpdir(), 'keo-start-profile');
require('fs').rmSync(PROFILE, { recursive: true, force: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const out = {};
  let ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, acceptDownloads: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  await wait(2000);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  const act = async (sel) => { await page.evaluate(() => { window.__last = null; }); await page.click(sel); await page.waitForFunction(() => window.__last, null, { timeout: 20000 }); return page.evaluate(() => window.__last); };
  await page.goto(`chrome-extension://${ID}/start.html`);
  if (await page.$('#toggle')) await page.click('#toggle');   // the world build keeps the account controls in a toggled panel
  out.statusBefore = await page.textContent('#status');
  out.create = await act('#create');
  await page.reload();
  if (await page.$('#toggle')) await page.click('#toggle');
  out.statusAfterReload = await page.textContent('#status');
  out.signIn = await act('#signin');
  const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
  out.export = await act('#export');
  const d = await dl; if (d) { const p = path.join(path.resolve(process.argv[5]), 'keo-identity-draft.json'); await d.saveAs(p); out.exportFile = p; }
  // second launch, same profile: does the local account persist across a browser restart? (the virtual authenticator itself does not, so no sign-in here)
  await ctx.close();
  ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  await wait(2000);
  const p2 = await ctx.newPage(); await p2.goto(`chrome-extension://${ID}/start.html`);
  out.statusAfterRestart = await p2.textContent('#status');
  await ctx.close();
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
})().catch((e) => { console.log('FATAL', String(e).slice(0, 500)); process.exit(1); });
