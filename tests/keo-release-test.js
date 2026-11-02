// Node test for keo-release.js and sign-release.js: no browser. A throwaway key is made with the real tool and used to sign a
// small fake package; the same verifier a client will use then has to accept it, and to refuse every kind of damaged or
// hostile release, including ones that carry a VALID signature (the signer's mistakes, or a stolen key's output, must not
// be able to write outside the package or change a file the overlay may not carry).
// Usage: node keo-release-test.js [a built package folder, to check its keo-files.json and sign it too]
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const kd = require('../shell/keo-did.js');
const kr = require('../shell/keo-release.js');
const { listPackage } = require('../extension/package-files.js');
const subtle = crypto.webcrypto.subtle;
const TOOL = path.join(__dirname, '..', 'extension', 'sign-release.js');
let passed = 0;
const ok = (name, cond, extra) => { if (!cond) { console.error('FAIL ' + name + (extra ? ' ' + extra : '')); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } };
const rejects = async (name, p, re) => { try { await p; ok(name, false, 'accepted'); } catch (e) { ok(name, !re || re.test(e.message), e.message); } };
const tool = (args, env) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: Object.assign({}, process.env, { KEO_KEY_PASSPHRASE: '' }, env || {}) });
const write = (dir, rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keo-rel-'));
  const keyFile = path.join(tmp, 'key.json');

  // ---- the tool: keys ----
  const inside = tool(['keygen', '--out', path.join(__dirname, '..', 'never-written-key.json')]);
  ok('keygen refuses to write the private key inside the repository', inside.status !== 0 && !fs.existsSync(path.join(__dirname, '..', 'never-written-key.json')));
  const g = tool(['keygen', '--out', keyFile]);
  ok('keygen writes a key file and prints the public key', g.status === 0 && fs.existsSync(keyFile) && /"publicKey"/.test(g.stdout), g.stderr);
  ok('keygen refuses to overwrite', tool(['keygen', '--out', keyFile]).status !== 0);
  const keyDoc = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  const pinned = { keys: [{ kid: keyDoc.kid, alg: 'Ed25519', publicKey: keyDoc.publicKey }] };
  const keys = await kr.loadKeys(pinned);
  const priv = await subtle.importKey('pkcs8', kd.unb64u(keyDoc.private.pkcs8), 'Ed25519', false, ['sign']);

  // our own signer for hostile manifests: same format, any manifest text
  const sealWith = async (manifestText, opts) => {
    opts = opts || {};
    const payload = new TextEncoder().encode(manifestText), pre = opts.noDomain ? new Uint8Array(0) : new TextEncoder().encode(kr.DOMAIN);
    const msg = new Uint8Array(pre.length + payload.length); msg.set(pre); msg.set(payload, pre.length);
    return { v: 1, kid: keyDoc.kid, payload: kd.b64u(payload), sig: kd.b64u(new Uint8Array(await subtle.sign('Ed25519', priv, msg))) };
  };
  const H = 'a'.repeat(64);
  const mani = (over) => JSON.stringify(Object.assign({ v: 1, type: 'keo-release', version: 5, name: 't', issuedAt: new Date().toISOString(), kernel: { commit: 'abcdef1' }, files: { 'core/a.js': { sha256: H, size: 3 } } }, over));

  // ---- a fake package, version 1 ----
  const pkg = path.join(tmp, 'pkg');
  const base = {
    'manifest.json': '{}', 'start.html': 'v1', 'shell.js': 'v1', 'world.html': 'v1', 'keo-shim.js': 'v1',
    'core/lively/A.js': 'a1', 'core/lively/C.js': 'c1', 'core/lively/localconfig.js': 'cfg1', 'core/lib/libsodium/sodium.js': 's1',
    'core/lively/identity/IdentityVaultFrame.js': 'f1', 'generated/h1/combinedModules.js': 'b1', 'core/media/x.png': 'p1',
    'stub/login.json': '{}', 'keo-build.json': JSON.stringify({ kernel: { commit: '0123abc' } }), '.keo-world-build': 'marker', 'keo-files.json': 'old'
  };
  Object.keys(base).forEach((k) => write(pkg, k, base[k]));
  const baseline = listPackage(pkg);
  ok('the file list leaves out the builder marker and keo-files.json', !('.keo-world-build' in baseline) && !('keo-files.json' in baseline) && Object.keys(baseline).length === Object.keys(base).length - 2);

  // ---- a good release ----
  const out1 = path.join(tmp, 'r1.json');
  const s1 = tool(['sign', pkg, '--key', keyFile, '--version', '1', '--name', '0.0.1', '--out', out1]);
  ok('sign writes a release', s1.status === 0 && fs.existsSync(out1), s1.stderr);
  ok('sign refuses to overwrite a release', tool(['sign', pkg, '--key', keyFile, '--version', '1', '--name', 'x', '--out', out1]).status !== 0);
  const env1 = JSON.parse(fs.readFileSync(out1, 'utf8'));
  const m1 = await kr.verifyEnvelope(env1, keys);
  ok('the client verifier accepts it: version, name, kernel commit', m1.version === 1 && m1.name === '0.0.1' && m1.kernel.commit === '0123abc');
  ok('it lists exactly the package files, with their hashes', JSON.stringify(Object.keys(m1.files).sort()) === JSON.stringify(Object.keys(baseline).sort()) && m1.files['core/lively/A.js'].sha256 === baseline['core/lively/A.js'].sha256);

  // ---- damage ----
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  await rejects('a changed payload is refused', kr.verifyEnvelope(Object.assign({}, env1, { payload: flip(env1.payload, 40) }), keys), /bad signature|manifest/);
  await rejects('a changed signature is refused', kr.verifyEnvelope(Object.assign({}, env1, { sig: flip(env1.sig, 10) }), keys), /bad signature/);
  await rejects('a truncated signature is refused', kr.verifyEnvelope(Object.assign({}, env1, { sig: env1.sig.slice(0, 40) }), keys), /signature length/);
  const other = await subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const otherPub = kd.b64u(new Uint8Array(await subtle.exportKey('raw', other.publicKey)));
  const otherKeys = await kr.loadKeys({ keys: [{ kid: await kr.keyId(otherPub), alg: 'Ed25519', publicKey: otherPub }] });
  await rejects('a release signed by a key that is not pinned is refused', kr.verifyEnvelope(env1, otherKeys), /not pinned/);
  await rejects('naming another pinned key does not borrow its trust', kr.verifyEnvelope(Object.assign({}, env1, { kid: otherKeys[0].kid }), keys.concat(otherKeys)), /bad signature/);
  await rejects('an envelope with a missing field is refused', kr.verifyEnvelope({ v: 1, kid: env1.kid, payload: env1.payload }, keys), /malformed/);
  await rejects('a signature made without the domain prefix is refused', kr.verifyEnvelope(await sealWith(mani(), { noDomain: true }), keys), /bad signature/);
  await rejects('a pinned key whose id does not match is refused', kr.loadKeys({ keys: [{ kid: '0000000000000000', alg: 'Ed25519', publicKey: keyDoc.publicKey }] }), /does not match/);
  const two = await kr.loadKeys({ keys: [pinned.keys[0], { kid: await kr.keyId(otherPub), alg: 'Ed25519', publicKey: otherPub }] });
  ok('several pinned keys are accepted (rotation)', two.length === 2 && (await kr.verifyEnvelope(env1, two)).version === 1);

  // ---- validly signed but hostile or broken manifests ----
  const bad = async (name, over, re) => rejects(name, kr.verifyEnvelope(await sealWith(mani(over)), keys), re);
  const F = (p) => ({ files: { [p]: { sha256: H, size: 1 } } });
  for (const p of ['../x.js', '/etc/x', 'core//a.js', 'core/./a.js', 'core/%2e%2e/a.js', 'core\\a.js', 'core/a.js?x', 'core/a b.js', 'core/', '', 'core/..']) await bad('a signed path ' + JSON.stringify(p) + ' is refused', F(p), /bad path/);
  await bad('a signed manifest with no files is refused', { files: {} }, /file count/);
  await bad('a bad hash is refused', { files: { 'core/a.js': { sha256: 'xyz', size: 1 } } }, /bad entry/);
  await bad('a negative size is refused', { files: { 'core/a.js': { sha256: H, size: -1 } } }, /bad entry/);
  await bad('version 0 is refused', { version: 0 }, /bad version/);
  await bad('a fractional version is refused', { version: 1.5 }, /bad version/);
  await bad('another type is refused', { type: 'something-else' }, /not a release/);
  await bad('an odd kernel commit is refused', { kernel: { commit: 'rm -rf' } }, /kernel commit/);
  const many = {}; for (let i = 0; i < 20001; i++) many['core/f' + i + '.js'] = { sha256: H, size: 1 };
  await bad('too many files are refused', { files: many }, /file count/);
  await rejects('a payload that is not JSON is refused', kr.verifyEnvelope(await sealWith('not json'), keys), /manifest/);
  const proto = await kr.verifyEnvelope(await sealWith('{"v":1,"type":"keo-release","version":2,"name":"p","issuedAt":"2026-01-01T00:00:00Z","kernel":{"commit":null},"files":{"__proto__":{"sha256":"' + H + '","size":1}}}'), keys);
  ok('a file named __proto__ is data, not a prototype', Object.keys(proto.files).includes('__proto__') && ({}).sha256 === undefined && Object.getPrototypeOf(proto.files) === null);

  // ---- what to do with it ----
  write(pkg, 'core/lively/A.js', 'a2'); write(pkg, 'core/lively/B.js', 'b2'); write(pkg, 'start.html', 'v2'); write(pkg, 'core/lively/localconfig.js', 'EVIL');
  write(pkg, 'core/lib/libsodium/sodium.js', 's2'); write(pkg, 'core/lively/identity/IdentityVaultFrame.js', 'f2'); write(pkg, 'core/media/x.png', 'p2');
  write(pkg, 'generated/h1/combinedModules.js', 'b2'); fs.rmSync(path.join(pkg, 'stub/login.json'));
  const out2 = path.join(tmp, 'r2.json');
  ok('sign a second release', tool(['sign', pkg, '--key', keyFile, '--version', '2', '--name', '0.0.2', '--out', out2]).status === 0);
  const m2 = await kr.verifyEnvelope(JSON.parse(fs.readFileSync(out2, 'utf8')), keys);
  const installed = { version: 1, files: Object.fromEntries(Object.entries(baseline).map(([p, e]) => [p, e.sha256])) };
  const plan = kr.planUpdate(m2, installed);
  ok('plan: world code and the boot bundle are applied, changed or new', JSON.stringify(plan.apply.map((x) => x.path)) === JSON.stringify(['core/lively/A.js', 'core/lively/B.js', 'generated/h1/combinedModules.js']), JSON.stringify(plan.apply));
  ok('plan: shell page, vault code, rpId config and binary files need a new package', JSON.stringify(plan.needsNewPackage) === JSON.stringify(['core/lib/libsodium/sodium.js', 'core/lively/identity/IdentityVaultFrame.js', 'core/lively/localconfig.js', 'core/media/x.png', 'start.html']), JSON.stringify(plan.needsNewPackage));
  ok('plan: a dropped file is reported, not applied; the rest is unchanged', JSON.stringify(plan.removed) === JSON.stringify(['stub/login.json']) && plan.unchanged > 0);
  let replay = null; try { kr.planUpdate(m1, installed); } catch (e) { replay = e; }
  ok('plan: an older signed release is refused (replay)', replay && /not newer/.test(replay.message));
  let same = null; try { kr.planUpdate(m2, { version: 2, files: installed.files }); } catch (e) { same = e; }
  ok('plan: the release already applied is refused', same && /not newer/.test(same.message));
  ok('overlayable: only world-loaded text files', kr.overlayable('core/lively/A.js') && kr.overlayable('generated/x/combinedModules.js') && !kr.overlayable('keo-shim.js') && !kr.overlayable('manifest.json') && !kr.overlayable('core/lively/localconfig.js') && !kr.overlayable('core/lib/libsodium/sodium.js') && !kr.overlayable('core/media/x.png') && !kr.overlayable('../core/a.js'));

  // ---- a downloaded file ----
  const e = m2.files['core/lively/A.js'];
  ok('checkFile: the right bytes pass', await kr.checkFile(e, Buffer.from('a2')));
  ok('checkFile: other bytes of the same size fail', !(await kr.checkFile(e, Buffer.from('a3'))));
  ok('checkFile: a different size fails', !(await kr.checkFile(e, Buffer.from('a22'))));

  // ---- an encrypted key ----
  const encKey = path.join(tmp, 'enc.json');
  ok('keygen encrypts the private key when a passphrase is set', tool(['keygen', '--out', encKey], { KEO_KEY_PASSPHRASE: 'correct horse' }).status === 0 && !/pkcs8/.test(fs.readFileSync(encKey, 'utf8')));
  const sargs = (o) => ['sign', pkg, '--key', encKey, '--version', '3', '--name', 'x', '--out', path.join(tmp, o)];
  ok('signing with an encrypted key needs the passphrase', tool(sargs('e0.json')).status !== 0);
  ok('signing with a wrong passphrase fails', tool(sargs('e1.json'), { KEO_KEY_PASSPHRASE: 'nope' }).status !== 0);
  ok('signing with the right passphrase works', tool(sargs('e2.json'), { KEO_KEY_PASSPHRASE: 'correct horse' }).status === 0);

  // ---- a built package, when one is given ----
  if (process.argv[2]) {
    const built = process.argv[2];
    const files = JSON.parse(fs.readFileSync(path.join(built, 'keo-files.json'), 'utf8')).files;
    ok('built package: keo-files.json matches the files on disk', JSON.stringify(files) === JSON.stringify(listPackage(built)));
    ok('built package: it signs and verifies', tool(['sign', built, '--key', keyFile, '--version', '1', '--name', 'built', '--out', path.join(tmp, 'built.json')]).status === 0);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(process.exitCode ? 'FAILED' : passed + ' checks passed');
})().catch((e) => { console.error(e); process.exit(2); });
