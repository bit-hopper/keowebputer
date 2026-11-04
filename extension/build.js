// Assemble the keo world extension: shell page start.html + sandboxed world.html + the static
// files a plain boot of blank.html requests, so the world runs from the package with no server.
// Usage: node build.js <output folder> [--version <release tag, e.g. v0 or v0.2.1>]
//   --version the release this package is, written as the extension's version (what the browser shows for it). A leading "v" is
//             dropped; what is left must be one to four dot-separated whole numbers (0-65535), which is all the browser accepts.
//             Also read from $KEO_VERSION. Without it the version is 0.0.0, so a local build is never taken for a release.
// The runtime's files come from kernel/ in this repository, a snapshot of the kernel's shipped files that refresh-kernel.js
// writes (including the boot bundle and the minified editor files), so a build needs no kernel checkout, no server and no
// npm packages. This script adds keo's own files, the settings, the world document and the manifest. Run from anywhere.
// Writes keo-build.json into the package: the kernel commit the snapshot was taken from.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { listPackage } = require('./package-files');
const { LISTED_DIRS } = require('./kernel-list');

// ---- arguments
let OUT = null, VERSION_ARG = process.env.KEO_VERSION || null;
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--version') VERSION_ARG = a[++i];
    else if (!OUT) OUT = a[i];
    else { console.error('unexpected argument: ' + a[i]); process.exit(1); }
  }
}
if (!OUT) { console.error('usage: node build.js <output folder> [--version <release tag>]'); process.exit(1); }
const VERSION = VERSION_ARG ? String(VERSION_ARG).replace(/^v/, '') : '0.0.0';
if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(VERSION) || VERSION.split('.').some((n) => Number(n) > 65535)) {
  console.error('--version must be a release tag such as v0 or v0.2.1 (one to four dot-separated numbers, each up to 65535): ' + VERSION_ARG); process.exit(1);
}
const ROOT = path.join(__dirname, '..');
const KERNEL = path.join(ROOT, 'kernel');
for (const f of ['SNAPSHOT.json', 'blank.html', 'core/lively/bootstrap.js']) {
  if (!fs.existsSync(path.join(KERNEL, f))) { console.error('kernel/' + f + ' is missing: kernel/ is the snapshot refresh-kernel.js writes'); process.exit(1); }
}
const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(KERNEL, 'SNAPSHOT.json'), 'utf8'));
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

let bytes = 0, files = 0;
const put = (rel, data) => { const p = path.join(OUT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); bytes += data.length; files++; };
// What the snapshot holds at its top level that is not a package file as it stands: the world's document (becomes world.html),
// the licence notices (renamed below) and the record of where the snapshot came from.
const SNAPSHOT_ONLY = new Set(['SNAPSHOT.json', 'blank.html', 'LICENSE', 'AUTHORS']);
const copySnapshot = (rel) => {
  for (const e of fs.readdirSync(path.join(KERNEL, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) copySnapshot(r); else if (!SNAPSHOT_ONLY.has(r)) put(r, fs.readFileSync(path.join(KERNEL, r)));
  }
};

// A WebDAV multistatus answer for the folder `rel` of the snapshot: the folder itself, then each file in it. The runtime
// only lists these folders (names, sizes, types); every entry is a file, which is checked here because a subfolder would
// need its own entry shape.
const propfind = (rel) => {
  const entry = (href, stat, isDir) => '<d:response><d:href>' + href + '</d:href><d:propstat><d:prop>' +
    '<d:getlastmodified xmlns:b="urn:uuid:c2f41010-65b3-11d1-a29f-00aa00c14882/" b:dt="dateTime.rfc1123">' + stat.mtime.toUTCString() + '</d:getlastmodified>' +
    (isDir ? '<d:resourcetype><d:collection/></d:resourcetype>'
           : '<d:getcontentlength>' + stat.size + '</d:getcontentlength><d:resourcetype></d:resourcetype><d:getcontenttype>' +
             (href.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'application/octet-stream') + '</d:getcontenttype>') +
    '</d:prop><d:status>HTTP/1.1 200 Ok</d:status></d:propstat></d:response>';
  const dir = path.join(KERNEL, rel), names = fs.readdirSync(dir).sort();
  let xml = '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:a="http://ajax.org/2005/aml">' + entry('/' + rel + '/', fs.statSync(dir), true);
  for (const n of names) {
    const st = fs.statSync(path.join(dir, n));
    if (st.isDirectory()) throw new Error('propfind: ' + rel + '/' + n + ' is a folder; the listing shape for folders in a listing is not implemented');
    xml += entry('/' + rel + '/' + encodeURIComponent(n).replace(/%2F/g, '/'), st, false);
  }
  return xml + '</d:multistatus>';
};

(async () => {
  // 1. every file the snapshot holds: the boot files, the modules and libraries, the editor files, the boot bundle (see
  //    refresh-kernel.js for what is in it and why). localconfig.js is not among them: it is written below.
  copySnapshot('');
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
// Who may save a world is decided by the shell (keo-worlds.js saves only under the signed-in identity). The runtime's own
// check asks a server for the user and, finding none, stops the save on a "log in now?" dialog that cannot succeed here.
lively.Config.set('checkWriteAuthorizationOfUsers', false);
`);
  // 2. the directory listings the kernel's server would answer (a PROPFIND answer for a folder with no subfolders, same shape
  //    the server gives); the boot bundle they sit beside is already in the snapshot
  const hash = SNAPSHOT.bundleHash;
  for (const d of LISTED_DIRS) put('webdav-index/' + (d + '/').replace(/\//g, '_') + '.xml', propfind(d));
  put('stub/empty.txt', '');
  put('stub/login.json', JSON.stringify({ username: 'unknown user', email: null, group: null, lastLogin: null }, null, 2));

  // 3. world.html: the snapshot's blank.html (as the kernel committed it) minus its style blocks (the bootstrap removes them
  //    anyway), with the shim loaded before the bootstrap
  let html = fs.readFileSync(path.join(KERNEL, 'blank.html'), 'utf8');
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
  for (const f of ['shell.js', 'shell-store.js', 'keo-overlay.js', 'keo-did.js', 'keo-hello.js', 'keo-identity.js', 'keo-p2p.js', 'keo-callsdp.js', 'keo-identicon.js', 'keo-confirm.js', 'keo-call.js', 'keo-dm.js', 'keo-chatlog.js', 'keo-contacts.js', 'keo-wordlist.js', 'keo-fingerprint.js', 'keo-friend.js', 'keo-worlds.js', 'keo-gate.js']) put(f, fs.readFileSync(path.join(SHELL, f)));
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

  // The package carries LivelyKernel's code. It is MIT licensed and its notice has to travel with it. So does the list of what
  // is known about the licences of the libraries it vendors, which is kernel/THIRD-PARTY-NOTICES.md and so is copied with the
  // snapshot to the package root.
  for (const [from, to] of [['LICENSE', 'LICENSE-lively-kernel'], ['AUTHORS', 'AUTHORS-lively-kernel']]) put(to, fs.readFileSync(path.join(KERNEL, from)));

  // 5b. Work in progress that is not committed: whatever is under extension/local/ (gitignored) is copied into the package at the
  //     same path. It is for a LOCAL build (the landing page the world starts from while it is unfinished, and the pictures it
  //     shows); a CI build has no such folder and ships none of it. It may add files, never replace one the build wrote.
  const LOCAL = path.join(__dirname, 'local');
  if (fs.existsSync(LOCAL)) {
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else {
          if (fs.existsSync(path.join(OUT, r))) throw new Error('extension/local/' + r + ' would replace a file the build wrote');
          put(r, fs.readFileSync(path.join(dir, e.name)));
        }
      }
    };
    walk(LOCAL, '');
    console.warn('extension/local/ is present: its files are in this package (not a committed build)');
  }

  // 5. where this package came from: the kernel commit the snapshot in kernel/ was taken from (the snapshot is verbatim, so
  //    the commit says what the runtime's files are). gateWorld says the package carries a landing page for the world to start
  //    from (see 5b). The shell does not read it (a package without one starts the blank world with the sign-in dialog open); it
  //    is there so a test, or a person looking at a package, can tell which of the two it is. Written after 5b for that.
  put('keo-build.json', JSON.stringify({
    builtAt: new Date().toISOString(), version: VERSION, extensionId: id, bundleHash: hash,
    kernel: { commit: SNAPSHOT.commit }, gateWorld: fs.existsSync(path.join(OUT, 'gate-world.html'))
  }, null, 2) + '\n');

  // 6. every file with its hash, written last. It is the baseline an update is diffed against (what the package has), not a
  //    security statement: whatever an update downloads is checked against the signed release, never against this.
  put('keo-files.json', JSON.stringify({ v: 1, files: listPackage(OUT) }) + '\n');

  console.log('built ' + OUT + ': ' + files + ' files, ' + bytes + ' bytes, extension id ' + id + ', bundle ' + hash + ', kernel ' + SNAPSHOT.commit.slice(0, 7));
})().catch((e) => { console.error(e); process.exit(1); });
