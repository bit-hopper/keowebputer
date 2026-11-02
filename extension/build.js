// Assemble the keo world extension: shell page start.html + sandboxed world.html + the static
// files a plain boot of blank.html requests, so the world runs from the package with no server.
// Usage: node build.js <output folder> [--kernel <LivelyKernel checkout>] [--version <release tag, e.g. v0 or v0.2.1>]
//   --kernel  the LivelyKernel checkout the package is made from (its core/, blank.html, node_modules/esbuild, babel).
//             Also read from $KEO_KERNEL. With neither, a folder named LivelyKernel next to this repository is used if
//             (and only if) it looks like a kernel.
//   --version the release this package is, written as the extension's version (what the browser shows for it). A leading "v" is
//             dropped; what is left must be one to four dot-separated whole numbers (0-65535), which is all the browser accepts.
//             Also read from $KEO_VERSION. Without it the version is 0.0.0, so a local build is never taken for a release.
// Needs no server: the generated combinedModules bundle comes from kernel-bundle.js and the WebDAV directory listings are
// written from the folders. Needs the kernel's `npm install` done. Run from anywhere.
// Writes keo-build.json into the package: which kernel commit it was built from, and whether the files it copied differed
// from that commit (the package is made from the working tree, not from the commit).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { buildBundle } = require('./kernel-bundle');
const { listPackage } = require('./package-files');

// ---- arguments
let OUT = null, KERNEL_ARG = process.env.KEO_KERNEL || null, VERSION_ARG = process.env.KEO_VERSION || null;
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--kernel') KERNEL_ARG = a[++i];
    else if (a[i] === '--version') VERSION_ARG = a[++i];
    else if (!OUT) OUT = a[i];
    else { console.error('unexpected argument: ' + a[i]); process.exit(1); }
  }
}
if (!OUT) { console.error('usage: node build.js <output folder> [--kernel <LivelyKernel checkout>] [--version <release tag>]'); process.exit(1); }
const VERSION = VERSION_ARG ? String(VERSION_ARG).replace(/^v/, '') : '0.0.0';
if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(VERSION) || VERSION.split('.').some((n) => Number(n) > 65535)) {
  console.error('--version must be a release tag such as v0 or v0.2.1 (one to four dot-separated numbers, each up to 65535): ' + VERSION_ARG); process.exit(1);
}
// Files a folder must have to be taken for a LivelyKernel checkout this script can build from.
const KERNEL_MARKERS = ['core/lively/bootstrap.js', 'blank.html', 'core/lively/identity/IdentityVaultFrame.js'];
const isKernel = (dir) => KERNEL_MARKERS.every((f) => fs.existsSync(path.join(dir, f)));
const REPO = path.resolve(KERNEL_ARG || path.join(__dirname, '..', '..', 'LivelyKernel'));
if (!isKernel(REPO)) {
  console.error((KERNEL_ARG ? 'not a LivelyKernel checkout: ' : 'no --kernel given, and there is no LivelyKernel checkout next to this repository: ') + REPO +
    '\npass --kernel <path> (or set KEO_KERNEL). A kernel has: ' + KERNEL_MARKERS.join(', '));
  process.exit(1);
}
const ROOT = path.join(__dirname, '..');
const SHELL = path.join(ROOT, 'shell'), WORLD = path.join(ROOT, 'world');   // the two realms' sources; this folder holds the builder, the boot list and the pinned key
const MARKER = path.join(OUT, '.keo-world-build');
// The public key pinned in the manifest fixes the extension id, which is the origin and the passkey rpId everywhere below.
const der = Buffer.from(JSON.parse(fs.readFileSync(path.join(__dirname, 'extension-key.json'), 'utf8')).spkiBase64, 'base64');
const id = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
const EXT_ORIGIN = 'chrome-extension://' + id;

// Refuse to write into a folder that is not empty and not one of our own earlier builds.
if (fs.existsSync(OUT) && fs.readdirSync(OUT).length && !fs.existsSync(MARKER)) {
  console.error('refusing to build into a non-empty folder that this script did not create: ' + OUT); process.exit(1);
}
if (fs.existsSync(OUT)) for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(MARKER, 'built by extension/build.js\n');

// libraries (and their workers) that on-demand features load; add a directory here when a feature is found to need one
const ONDEMAND_LIBS = ['core/lib/marked', 'core/lib/logo', 'core/lib/ml', 'core/lib/scheme',
  'core/lib/geo', 'core/lib/astro', 'core/lib/postcard', 'core/media', 'core/styles'];
const ONDEMAND_FILES = ['core/lib/grasp.js', 'core/lib/escodegen.browser.js', 'core/lib/lively.ast.dev.js', 'core/lib/lively-libs.js'];
// Also not shipped yet: core/lib/privacy-pools (23 MB) and core/lib/mediapipe (16 MB, face effects); add them here when the
// feature that loads them is brought over. See NOT_SHIPPED above for what is deliberately never shipped.
// Not shipped by decision: core/lib/pyodide (Python, 25 MB) and core/lib/wallet (crypto bundles, 11 MB). The kernel modules
// that load them (PyodideWorker, Wallet*, PrivacyPoolClient) are still copied with core/lively and fail at first use.

let bytes = 0, files = 0;
const put = (rel, data) => { const p = path.join(OUT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); bytes += data.length; files++; };
const copy = (rel) => put(rel, fs.readFileSync(path.join(REPO, rel)));
// Not shipped: apps and heavy assets that come from the inventory (or are not used at run time) instead of the package.
// Jenga3D (module code here, its 50 MB of libraries under core/lib/jenga3d), MicroBlocks, Snap and the like are downloaded
// from the inventory on demand.
const NOT_SHIPPED = ['core/lively/jenga3d', 'core/lib/jenga3d'];
const copyDir = (rel) => { if (NOT_SHIPPED.includes(rel)) return; for (const e of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
  if (e.isDirectory()) copyDir(rel + '/' + e.name); else copy(rel + '/' + e.name); } };

// A WebDAV multistatus answer for the folder `rel` of the kernel: the folder itself, then each file in it. The runtime
// only lists these folders (names, sizes, types); every entry is a file, which is checked here because a subfolder would
// need its own entry shape.
const propfind = (rel) => {
  const entry = (href, stat, isDir) => '<d:response><d:href>' + href + '</d:href><d:propstat><d:prop>' +
    '<d:getlastmodified xmlns:b="urn:uuid:c2f41010-65b3-11d1-a29f-00aa00c14882/" b:dt="dateTime.rfc1123">' + stat.mtime.toUTCString() + '</d:getlastmodified>' +
    (isDir ? '<d:resourcetype><d:collection/></d:resourcetype>'
           : '<d:getcontentlength>' + stat.size + '</d:getcontentlength><d:resourcetype></d:resourcetype><d:getcontenttype>' +
             (href.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'application/octet-stream') + '</d:getcontenttype>') +
    '</d:prop><d:status>HTTP/1.1 200 Ok</d:status></d:propstat></d:response>';
  const dir = path.join(REPO, rel), names = fs.readdirSync(dir).sort();
  let xml = '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:a="http://ajax.org/2005/aml">' + entry('/' + rel + '/', fs.statSync(dir), true);
  for (const n of names) {
    const st = fs.statSync(path.join(dir, n));
    if (st.isDirectory()) throw new Error('propfind: ' + rel + '/' + n + ' is a folder; the listing shape for folders in a listing is not implemented');
    xml += entry('/' + rel + '/' + encodeURIComponent(n).replace(/%2F/g, '/'), st, false);
  }
  return xml + '</d:multistatus>';
};

(async () => {
  // 1. static boot files (list produced from probes/boot-inventory.js)
  const list = fs.readFileSync(path.join(__dirname, 'boot-files.txt'), 'utf8').split(/\r?\n/).filter((l) => l && l[0] !== '#');
  // localconfig.js is written below from this build's own settings: the kernel's copy is untracked and differs per machine
  // (a fresh checkout does not have it), so a package that read it could not be rebuilt from a commit.
  for (const rel of list) if (rel !== 'core/lively/localconfig.js') copy(rel);
  // On-demand features: the module loader fetches a module by URL when a feature is first used, so the package carries
  // every module file (a missing one fails at first use, not at boot), and the libraries and workers those features load.
  // The boot list above stays the record of what a plain boot needs; the later copies (localconfig.js below) win.
  copyDir('core/lively');
  // Ace is a vendored 2013-era fork: ship its bundle and the lazily loaded mode files minified (the repo keeps them readable)
  // and leave out what nothing loads: the 1.5 MB duplicate bundle, the build script, the syntax-check workers (the session
  // setup turns workers off), ext-* files and ace's own snippets (Lively's are under core/lively/ide/snippets).
  // Measured: a run through 21 text modes requested lively-ace.js and nine mode-*.js files, no theme, worker or snippet file.
  // Ace's BSD licence asks for its notice to stay with redistributions, so each file keeps the leading licence block.
  const esbuild = require(path.join(REPO, 'node_modules', 'esbuild'));
  const minified = (rel) => {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const m = src.match(/^\s*\/\*[\s\S]*?END LICENSE BLOCK[\s\S]*?\*\//);
    const code = esbuild.transformSync(src, { minify: true, legalComments: 'none', logLevel: 'silent' }).code;
    return (m ? m[0].trim() + '\n' : '') + code;
  };
  for (const f of fs.readdirSync(path.join(REPO, 'core/lib/ace'))) {
    if (f === 'lively-ace.js' || /^mode-.*\.js$/.test(f) || /^ace\..*\.js$/.test(f)) put('core/lib/ace/' + f, minified('core/lib/ace/' + f));
  }
  put('core/lib/ace/LICENSE', fs.readFileSync(path.join(REPO, 'core/lib/ace/LICENSE')));
  for (const d of ONDEMAND_LIBS) copyDir(d);
  for (const f of ONDEMAND_FILES) copy(f);
  copy('core/media/lively.ico');
  // the identity vault page (vault.html below) runs this file and libsodium, neither of which a plain boot loads
  copy('core/lively/identity/IdentityVaultFrame.js');
  copy('core/lib/libsodium/sodium.js');
  // localconfig.js is loaded at boot. Everything else takes the kernel's config.json defaults; this sets what makes the
  // identity code use the extension as its origin: the passkey rpId, and the shell as the vault host (see config.json)
  put('core/lively/localconfig.js', `/* Written by the keo extension build; not the kernel's localconfig.js. */
lively.Config.set('identityRpId', ${JSON.stringify(id)});
lively.Config.set('identityOrigin', ${JSON.stringify(EXT_ORIGIN)});
lively.Config.set('identityVaultOrigin', ${JSON.stringify(EXT_ORIGIN)});
lively.Config.set('identityVaultTransport', 'parent');
// The module load check (bootstrap.js loadMain, after this many ms) walks every property of window with a for-in, and in a
// sandboxed page reading window.caches throws SecurityError. It is a diagnostic only; "falsy" disables it.
lively.Config.set('moduleLoadTestTimeout', false);
// The per-user config module (users/<name>/config.js) is a server-era hook; the package has no users/ folder, so do not
// request one.
lively.Config.set('loadUserConfig', false);
`);
  // files the shipped stylesheets point at with url(...) (fonts, mostly); they load lazily, after boot, so the boot
  // inventory does not list them
  const have = new Set(list);
  for (const css of list.filter((f) => f.endsWith('.css'))) {
    const text = fs.readFileSync(path.join(REPO, css), 'utf8');
    for (const m of text.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g)) {
      if (/^(data:|https?:|\/\/|#)/.test(m[1])) continue;
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(css), m[1].split(/[?#]/)[0]));
      if (have.has(rel)) continue;
      have.add(rel);
      if (fs.existsSync(path.join(REPO, rel))) copy(rel); else console.warn('css refers to a missing file: ' + css + ' -> ' + rel);
    }
  }
  // directories the runtime lists with PROPFIND: ship every file in them
  const listed = ['core/lively/ide/codeeditor/modes', 'core/lively/ide/snippets'];
  for (const d of listed) copyDir(d);

  // 2. what the kernel's server would generate: the boot bundle (made by the kernel's own code, see kernel-bundle.js) and
  //    the directory listings (a PROPFIND answer for a folder with no subfolders, same shape the server gives)
  const { hash, code } = await buildBundle(REPO, path.join(ROOT, '.cache'));
  put('generated/combinedModulesHash.txt', hash);
  put('generated/' + hash + '/combinedModules.js', code);
  for (const d of listed) put('webdav-index/' + (d + '/').replace(/\//g, '_') + '.xml', propfind(d));
  put('stub/empty.txt', '');
  put('stub/login.json', JSON.stringify({ username: 'unknown user', email: null, group: null, lastLogin: null }, null, 2));

  // 3. world.html: the committed blank.html minus its style blocks (the bootstrap removes them anyway),
  //    with the shim loaded before the bootstrap
  let html = execSync('git show HEAD:blank.html', { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  html = html.replace(/<style[\s\S]*?<\/style>/g, '').replace('<title>blank</title>', '<title>keo world</title>');
  // A page served by the dev server gets "charset=utf-8" from the HTTP header; an extension page has no header, so without this
  // the page (and every script it loads) is decoded as the legacy single-byte charset (windows-1252) and non-ASCII source text turns to mojibake (the
  // submenu arrow "▶" showed as "â–¶").
  html = html.replace('<head>', '<head><meta charset="utf-8">');
  const boot = '<script type="text/javascript" src="core/lively/bootstrap.js"></script>';
  if (!html.includes(boot)) throw new Error('bootstrap script tag not found in blank.html');
  // the bootstrap is NOT a static tag any more: keo-boot.js adds it once the shell has answered the bridge handshake
  html = html.replace(boot, ['keo-shim.js', 'keo-bridge.js', 'keo-idb.js', 'keo-boot.js'].map((f) => '<script src="' + f + '"></script>').join(''));
  put('world.html', html);
  for (const f of ['keo-shim.js', 'keo-bridge.js', 'keo-idb.js', 'keo-boot.js']) put(f, fs.readFileSync(path.join(WORLD, f)));

  // 4. shell page, the vault page and the manifest
  put('start.html', fs.readFileSync(path.join(SHELL, 'start.html')));
  for (const f of ['shell.js', 'shell-store.js', 'keo-overlay.js', 'keo-did.js', 'keo-identity.js']) put(f, fs.readFileSync(path.join(SHELL, f)));
  put('start.js', fs.readFileSync(path.join(__dirname, 'panel.js')));   // the account panel in the shell bar; the package calls it start.js
  // The vault page as the server builds it (IdentityServer.js buildIdentityVaultPage), with the shell's origin as the one
  // app origin it will answer. Relative script paths: this page lives at the package root.
  put('vault.html', '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="vault-app-origins" content="' + EXT_ORIGIN + '"><title>keo identity vault</title></head><body>' +
    '<button id="unlock" type="button">Unlock with passkey</button>' +
    '<script src="core/lib/libsodium/sodium.js"></script><script src="core/lively/identity/IdentityVaultFrame.js"></script>' +
    '</body></html>\n');
  // The public key(s) a release must be signed with, pinned in the package. Without the file the package takes no updates.
  // (Never generate or sign here: the private key is held offline, see sign-release.js.)
  const updateKey = path.join(__dirname, 'update-key.json');
  if (fs.existsSync(updateKey)) put('update-key.json', fs.readFileSync(updateKey));
  else console.warn('no extension/update-key.json: this package will not take updates');
  put('keo-release.js', fs.readFileSync(path.join(SHELL, 'keo-release.js')));
  put('bg.js', "chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('start.html') }));\n");
  put('manifest.json', JSON.stringify({
    manifest_version: 3, name: 'keo (prototype)', version: VERSION, description: 'keo world from the package, no server. Prototype.',
    key: der.toString('base64'), action: { default_title: 'keo' }, background: { service_worker: 'bg.js' },
    sandbox: { pages: ['world.html'] },
    // Extension pages (shell, vault): the default script-src plus 'wasm-unsafe-eval', which libsodium's WebAssembly needs.
    // (The extension-page CSP is a separate setting from the sandbox one below.)
    // Default sandbox CSP plus blob: workers (the runtime's workers have to be created from blobs here, see 9.4h).
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'", sandbox: "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; worker-src 'self' blob:; child-src 'self' blob:;" },
  }, null, 2));

  // The package carries LivelyKernel's code. It is MIT licensed and its notice has to travel with it.
  for (const [from, to] of [['LICENSE', 'LICENSE-lively-kernel'], ['AUTHORS', 'AUTHORS-lively-kernel']]) if (fs.existsSync(path.join(REPO, from))) put(to, fs.readFileSync(path.join(REPO, from)));

  // 5. where this package came from. The files above were copied from the kernel's WORKING TREE (only blank.html comes from
  //    the commit), so "commit" alone does not say what is in the package: `changed` lists what differed from it.
  const kernelGit = (args) => { try { return execSync('git ' + args, { cwd: REPO, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim(); } catch (e) { return null; } };
  const changed = kernelGit('status --porcelain -- core users blank.html');
  put('keo-build.json', JSON.stringify({
    builtAt: new Date().toISOString(), version: VERSION, extensionId: id, bundleHash: hash,
    kernel: { commit: kernelGit('rev-parse HEAD'), branch: kernelGit('rev-parse --abbrev-ref HEAD'),
      changed: changed === null ? null : changed.split('\n').filter(Boolean).slice(0, 100) }
  }, null, 2) + '\n');

  // 6. every file with its hash, written last. It is the baseline an update is diffed against (what the package has), not a
  //    security statement: whatever an update downloads is checked against the signed release, never against this.
  put('keo-files.json', JSON.stringify({ v: 1, files: listPackage(OUT) }) + '\n');

  console.log('built ' + OUT + ': ' + files + ' files, ' + bytes + ' bytes, extension id ' + id + ', bundle ' + hash + ', kernel ' + (kernelGit('rev-parse --short HEAD') || 'unknown') + (changed ? ' (+' + changed.split('\n').filter(Boolean).length + ' changed paths)' : ''));
})().catch((e) => { console.error(e); process.exit(1); });
