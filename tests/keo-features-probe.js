// Opens each on-demand feature in the built extension's world and reports what it asked the package for and could not get.
// Usage: node keo-features-probe.js <repo root> <extension folder> <work dir> [feature ...]
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const ONLY = process.argv.slice(5);
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'cgjphijackijgcjkfdfieihkbfooigjp', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FEATURES = {
  ace: `$world.addCodeEditor({ title: 'probe', content: 'var x = 1;', textMode: 'javascript', extent: pt(500, 300) }); return 'opened';`,
  aceModes: `const ed = $world.addCodeEditor({ title: 'p', content: 'x = 1', textMode: 'javascript', extent: pt(400, 200) }); await new Promise((r) => setTimeout(r, 2500)); const out = []; for (const m of ['javascript','python','haskell','c_cpp','r','scheme','yaml','log','markdown','html','css','json','sh','sql','xml','diff']) { ed.setTextMode(m); await new Promise((r) => setTimeout(r, 400)); out.push(m + ':' + ed.getTextMode()); } return out.join(' ');`,
  wiki: `await new Promise((r) => lively.require('lively.identity.WikiIndex').toRun(r)); lively.identity.WikiIndex.open('probe'); return 'opened';`,
  postcardEditor: `await new Promise((r) => lively.require('lively.identity.PostCardEditor').toRun(r)); lively.identity.PostCardEditor.create('probe', {}); return 'opened';`,
  mailbox: `await new Promise((r) => lively.require('lively.identity.PostCardMailbox').toRun(r)); lively.identity.PostCardMailbox.open(); return 'opened';`,
  lounge: `await new Promise((r) => lively.require('lively.identity.ConstellationLounge').toRun(r)); lively.identity.ConstellationLounge.open('probe'); return 'opened';`,
  room: `await new Promise((r) => lively.require('lively.identity.RoomView').toRun(r)); lively.identity.RoomView.open('probe', 'probe-room'); return 'opened';`,
};
// KEO_SNIPPET=<file>: run that file's async function body as one extra feature named "custom"
if (process.env.KEO_SNIPPET) FEATURES.custom = require('fs').readFileSync(process.env.KEO_SNIPPET, 'utf8');
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-feat-' + process.pid), { headless: false, viewport: { width: 1400, height: 900 },
    args: process.env.KEO_BASELINE ? [] : [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  const page = await ctx.newPage();
  let bucket = null;
  const note = (s) => { if (bucket) bucket.push(s); };
  page.on('requestfailed', (r) => note('REQFAIL ' + r.url().replace(/^chrome-extension:\/\/[a-p]+\//, '') + ' ' + (r.failure() || {}).errorText));
  page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure/.test(m.text())) note('console.error: ' + m.text().slice(0, 900).replace(/\n/g, ' ') + ' @' + (((m.location() || {}).url) || '').replace(/^chrome-extension:\/\/[a-p]+\//, '')); });
  page.on('pageerror', (e) => note('PAGEERROR ' + e.message.slice(0, 240)));
  // KEO_BASELINE=<url>: run against the normal server instead (the world is the page itself), to tell what is specific to the package
  let frame;
  if (process.env.KEO_BASELINE) { await page.goto(process.env.KEO_BASELINE); frame = page.mainFrame(); }
  else { await page.goto(`chrome-extension://${ID}/start.html#guest`);
  for (let i = 0; i < 100 && !frame; i++) { frame = page.frames().find((f) => /world\.html$/.test(f.url())); await sleep(200); } }
  for (let i = 0; i < 150; i++) { try { if (await frame.evaluate(() => !!(window.$world && window.$world.submorphs))) break; } catch (e) {} await sleep(300); }
  await sleep(1500);
  for (const name of Object.keys(FEATURES)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    bucket = [];
    let res;
    try { res = await frame.evaluate(new Function('return (async () => {' + FEATURES[name] + '})()')); } catch (e) { res = 'THROW ' + String(e).slice(0, 300); }
    await sleep(4000);
    const morphs = await frame.evaluate(() => $world.submorphs.length).catch(() => '?');
    await page.screenshot({ path: path.join(WORK, 'feat-' + name + '.png') });
    const uniq = Array.from(new Set(bucket));
    console.log('== ' + name + ': ' + res + ' (world submorphs ' + morphs + ', ' + uniq.length + ' distinct problems)');
    uniq.slice(0, 25).forEach((l) => console.log('   ' + l));
  }
  await ctx.close();
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
