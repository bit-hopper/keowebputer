// Shared by the browser tests that need the SAME code on TWO ORIGINS (one identity moved from one to the other): a second package is
// built here under a throwaway key, so it has another extension id, hence another origin and another passkey rpId. Never a release.
//   buildSecond(REPO, WORK)  -> { dir, id }   builds <WORK>/pkg-b with a fresh key (written to <WORK>/key-b.json) and says its id
//   idOfPackage(dir)         -> the extension id of a built package, derived from the key in its manifest the way the browser does
//   launch(chromium, dir, profile, WORK) -> { ctx, page }   a headed browser with that package loaded, `localhost` unresolvable, and a
//                            virtual authenticator with PRF attached to the page
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const idOfDer = (der) => crypto.createHash('sha256').update(der).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
const idOfPackage = (dir) => idOfDer(Buffer.from(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).key, 'base64'));

function buildSecond(REPO, WORK) {
  fs.mkdirSync(WORK, { recursive: true });
  const keyFile = path.join(WORK, 'key-b.json'), dir = path.join(WORK, 'pkg-b');
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(keyFile, JSON.stringify({ spkiBase64: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }));
  const built = cp.spawnSync(process.execPath, [path.join(REPO, 'extension', 'build.js'), dir, '--key', keyFile], { encoding: 'utf8' });
  if (built.status !== 0) { console.error(built.stdout + built.stderr); process.exit(2); }
  return { dir, id: idOfPackage(dir) };
}

async function launch(chromium, dir, profile, WORK) {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, profile), {
    headless: false, viewport: { width: 1100, height: 760 },
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message.slice(0, 200)));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  return { ctx, page };
}

module.exports = { idOfPackage, buildSecond, launch };
