// Sign a keo release. Run by the person who holds the release key, on their own machine: CI builds the package, this tool
// signs it, and nothing in the repository or CI ever holds the private key.
//
//   node extension/sign-release.js keygen --out <key file outside this repository>
//       Makes an Ed25519 key. Prints the public half; commit that as extension/update-key.json (the build puts it in the
//       package, where the shell pins it). The private half is written to the key file, encrypted with $KEO_KEY_PASSPHRASE if
//       that is set when you run keygen (and then it is needed again to sign). The tool refuses to write the key anywhere
//       inside this repository, and refuses to overwrite a file.
//   node extension/sign-release.js sign <built package folder> --key <key file> --version <integer> --name <label> [--out <file>]
//       Hashes every file of the package, signs the list and writes the envelope (default release-<version>.json). The
//       version must be higher than every release you have signed before: clients refuse one that is not higher than what
//       they run. The envelope is checked with the same verifier clients use before it is written.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kd = require('../shell/keo-did.js');
const kr = require('../shell/keo-release.js');
const { listPackage } = require('./package-files.js');
const subtle = crypto.webcrypto.subtle;

const REPO = path.resolve(__dirname, '..');
const die = (m) => { console.error(m); process.exit(1); };
function args(a) {
  const o = { _: [] };
  for (let i = 0; i < a.length; i++) { if (a[i].startsWith('--')) o[a[i].slice(2)] = a[++i]; else o._.push(a[i]); }
  return o;
}
const insideRepo = (p) => { const r = path.relative(REPO, path.resolve(p)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// scrypt + AES-256-GCM, only when a passphrase is given
function seal(plain, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(pass, salt, 32), iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { salt: kd.b64u(salt), iv: kd.b64u(iv), ct: kd.b64u(ct), tag: kd.b64u(c.getAuthTag()) };
}
function unseal(s, pass) {
  const d = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(pass, Buffer.from(kd.unb64u(s.salt)), 32), Buffer.from(kd.unb64u(s.iv)));
  d.setAuthTag(Buffer.from(kd.unb64u(s.tag)));
  return Buffer.concat([d.update(Buffer.from(kd.unb64u(s.ct))), d.final()]);
}

async function keygen(o) {
  if (!o.out) die('keygen needs --out <key file>');
  if (insideRepo(o.out)) die('refusing to put the private key inside this repository: ' + o.out);
  if (fs.existsSync(o.out)) die('refusing to overwrite ' + o.out);
  const pair = await subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pub = kd.b64u(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
  const pk8 = Buffer.from(await subtle.exportKey('pkcs8', pair.privateKey));
  const kid = await kr.keyId(pub);
  const pass = process.env.KEO_KEY_PASSPHRASE;
  const doc = { alg: 'Ed25519', kid, publicKey: pub, private: pass ? { encrypted: seal(pk8, pass) } : { pkcs8: kd.b64u(pk8) } };
  fs.writeFileSync(o.out, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('private key written to ' + o.out + (pass ? ' (encrypted with $KEO_KEY_PASSPHRASE)' : ' (NOT encrypted: set KEO_KEY_PASSPHRASE to encrypt)'));
  console.log('commit this as extension/update-key.json:\n' + JSON.stringify({ keys: [{ kid, alg: 'Ed25519', publicKey: pub }] }, null, 2));
}

async function sign(o) {
  const dir = o._[1];
  if (!dir || !o.key || !o.version || !o.name) die('usage: sign <package folder> --key <key file> --version <integer> --name <label> [--out <file>]');
  const version = Number(o.version);
  if (!Number.isSafeInteger(version) || version < 1) die('--version must be a positive integer');
  const doc = JSON.parse(fs.readFileSync(o.key, 'utf8'));
  let pk8;
  if (doc.private.encrypted) {
    if (!process.env.KEO_KEY_PASSPHRASE) die('this key is encrypted: set KEO_KEY_PASSPHRASE');
    try { pk8 = unseal(doc.private.encrypted, process.env.KEO_KEY_PASSPHRASE); } catch (e) { die('could not decrypt the key (wrong passphrase?)'); }
  } else pk8 = Buffer.from(kd.unb64u(doc.private.pkcs8));
  const priv = await subtle.importKey('pkcs8', pk8, 'Ed25519', false, ['sign']);

  let commit = null;
  try { commit = (JSON.parse(fs.readFileSync(path.join(dir, 'keo-build.json'), 'utf8')).kernel || {}).commit || null; } catch (e) {}
  const manifest = { v: 1, type: 'keo-release', version, name: String(o.name), issuedAt: new Date().toISOString(), kernel: { commit }, files: listPackage(dir) };
  const payload = new TextEncoder().encode(JSON.stringify(manifest));
  const signed = new Uint8Array(kr.DOMAIN.length + payload.length);
  signed.set(new TextEncoder().encode(kr.DOMAIN)); signed.set(payload, kr.DOMAIN.length);
  const sig = new Uint8Array(await subtle.sign('Ed25519', priv, signed));
  const env = { v: 1, kid: doc.kid, payload: kd.b64u(payload), sig: kd.b64u(sig) };

  // the check a client will make, against the public key in the same key file
  const keys = await kr.loadKeys({ keys: [{ kid: doc.kid, alg: 'Ed25519', publicKey: doc.publicKey }] });
  const back = await kr.verifyEnvelope(env, keys);
  const out = o.out || 'release-' + version + '.json';
  fs.writeFileSync(out, JSON.stringify(env) + '\n', { flag: 'wx' });
  console.log('signed release ' + back.version + ' (' + back.name + '): ' + Object.keys(back.files).length + ' files, key ' + doc.kid + ' -> ' + out);
}

const a = args(process.argv.slice(2));
const cmd = a._[0];
(cmd === 'keygen' ? keygen(a) : cmd === 'sign' ? sign(a) : Promise.reject(new Error('commands: keygen, sign (see the top of this file)'))).catch((e) => die(e.message || e));
