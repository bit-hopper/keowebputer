// Refresh kernel/ (the snapshot of the runtime's shipped files) from a LivelyKernel checkout.
// Usage: node extension/refresh-kernel.js [--kernel <LivelyKernel checkout>]
//   --kernel  the checkout to copy from. Also read from $KEO_KERNEL. With neither, a folder named LivelyKernel next to this
//             repository is used if (and only if) it looks like a kernel.
// kernel/ is a verbatim copy owned by this repository: build.js reads nothing else, so a build needs no kernel checkout.
// This is the one script that does, and it is run by a person when the snapshot should move to a newer kernel commit.
//   - Run it on a CLEAN checkout with line-ending conversion off (git clone -c core.autocrlf=false). It refuses when a file
//     it would copy differs from the checked-out commit, and only copies files the kernel tracks, so what lands in kernel/
//     is a function of the commit that SNAPSHOT.json records.
//   - Needs the kernel's `npm install` (esbuild for the editor files, and the packages the bundle step loads).
//   - It deletes and rewrites kernel/ completely, so a file the kernel removed leaves the snapshot. The exception is
//     THIRD-PARTY-NOTICES.md, which is kept by hand and carried over.
// What it copies is what a package ships from the kernel: the boot files, every module under core/lively, the on-demand
// libraries and workers, the editor files minified, the boot bundle the kernel's own code generates (kernel-bundle.js), the
// world's blank.html as committed, and the licence notices. build.js adds keo's own files and the settings on top.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { buildBundle } = require('./kernel-bundle');
const { LISTED_DIRS } = require('./kernel-list');

let KERNEL_ARG = process.env.KEO_KERNEL || null;
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--kernel') KERNEL_ARG = a[++i];
    else { console.error('unexpected argument: ' + a[i] + '\nusage: node extension/refresh-kernel.js [--kernel <LivelyKernel checkout>]'); process.exit(1); }
  }
}
// Files a folder must have to be taken for a LivelyKernel checkout this script can copy from.
const KERNEL_MARKERS = ['core/lively/bootstrap.js', 'blank.html', 'core/lively/identity/IdentityVaultFrame.js'];
const isKernel = (dir) => KERNEL_MARKERS.every((f) => fs.existsSync(path.join(dir, f)));
const ROOT = path.join(__dirname, '..');
const REPO = path.resolve(KERNEL_ARG || path.join(ROOT, '..', 'LivelyKernel'));
if (!isKernel(REPO)) {
  console.error((KERNEL_ARG ? 'not a LivelyKernel checkout: ' : 'no --kernel given, and there is no LivelyKernel checkout next to this repository: ') + REPO +
    '\npass --kernel <path> (or set KEO_KERNEL). A kernel has: ' + KERNEL_MARKERS.join(', '));
  process.exit(1);
}
const DEST = path.join(ROOT, 'kernel');

const git = (args) => execSync('git ' + args, { cwd: REPO, maxBuffer: 1 << 29, stdio: ['ignore', 'pipe', 'pipe'] });
const tracked = git('ls-files -z').toString('utf8').split('\0').filter(Boolean);
const isTracked = new Set(tracked);
const modified = new Set(git('diff --name-only -z HEAD').toString('utf8').split('\0').filter(Boolean));

// Files the snapshot leaves out, with the reason. Matching is by path prefix, so a folder covers what is under it.
// Apps and heavy assets that come from the inventory (or are not used at run time) instead of the package: Jenga3D (module
// code here, its 50 MB of libraries under core/lib/jenga3d), MicroBlocks, Snap and the like are downloaded on demand.
// The soundboard clips, two dead files under users/ and a note in the empty material-icons folder are not tracked by the
// kernel on purpose (the kernel ignores them); the module that plays the clips is copied and finds none.
const NOT_SHIPPED = ['core/lively/jenga3d', 'core/lib/jenga3d', 'core/media/soundboard',
  'core/lively/users/WebAuthn.js', 'core/lively/users/WebAuthnLoginMorph.js', 'core/media/material-icons/README.txt',
  'core/lib/app-fonts/vendor-fonts.js'];   // the script that fetched the fonts: it runs by hand, never in the browser
const skipped = (rel) => NOT_SHIPPED.some((n) => rel === n || rel.startsWith(n + '/'));
// Libraries (and their workers) that on-demand features load; add a directory here when a feature is found to need one.
const ONDEMAND_LIBS = ['core/lib/marked', 'core/lib/logo', 'core/lib/ml', 'core/lib/scheme',
  'core/lib/geo', 'core/lib/astro', 'core/lib/postcard', 'core/media', 'core/styles',
  'core/lib/app-fonts'];   // the fonts of the template apps, declared by core/styles/app-fonts.css (which the stylesheet scan above does not reach)
const ONDEMAND_FILES = ['core/lib/grasp.js', 'core/lib/escodegen.browser.js', 'core/lib/lively.ast.dev.js', 'core/lib/lively-libs.js'];
// Also not shipped yet: core/lib/privacy-pools (23 MB) and core/lib/mediapipe (16 MB, face effects); add them here when the
// feature that loads them is brought over.
// Not shipped by decision: core/lib/pyodide (Python, 25 MB) and core/lib/wallet (crypto bundles, 11 MB). The kernel modules
// that load them (PyodideWorker, Wallet*, PrivacyPoolClient) are still copied with core/lively and fail at first use.

const out = new Map();   // snapshot path -> bytes; a later put of the same path wins, as the boot list is only the record of a plain boot
const problems = [];
const put = (rel, data) => out.set(rel, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
const check = (rel) => {
  if (!isTracked.has(rel)) { problems.push('not tracked by the kernel: ' + rel); return false; }
  if (modified.has(rel)) { problems.push('differs from the checked-out commit: ' + rel); return false; }
  return true;
};
const read = (rel) => check(rel) ? fs.readFileSync(path.join(REPO, rel)) : null;
const copy = (rel) => { const data = read(rel); if (data) put(rel, data); };
const copyDir = (rel) => { for (const f of tracked) if (f.startsWith(rel + '/') && !skipped(f)) copy(f); };

(async () => {
  // 1. static boot files (list produced from probes/boot-inventory.js)
  const list = fs.readFileSync(path.join(__dirname, 'boot-files.txt'), 'utf8').split(/\r?\n/).filter((l) => l && l[0] !== '#');
  // localconfig.js is written by build.js from its own settings: the kernel's copy is untracked and differs per machine.
  for (const rel of list) if (rel !== 'core/lively/localconfig.js') copy(rel);
  // On-demand features: the module loader fetches a module by URL when a feature is first used, so the package carries
  // every module file (a missing one fails at first use, not at boot), and the libraries and workers those features load.
  copyDir('core/lively');
  // Ace is a vendored 2013-era fork: ship its bundle and the lazily loaded mode files minified (the kernel keeps them
  // readable) and leave out what nothing loads: the 1.5 MB duplicate bundle, the build script, the syntax-check workers (the
  // session setup turns workers off), ext-* files and ace's own snippets (Lively's are under core/lively/ide/snippets).
  // Measured: a run through 21 text modes requested lively-ace.js and nine mode-*.js files, no theme, worker or snippet file.
  // Ace's BSD licence asks for its notice to stay with redistributions, so each file keeps the leading licence block.
  const esbuild = require(path.join(REPO, 'node_modules', 'esbuild'));
  const minified = (rel) => {
    const src = (read(rel) || Buffer.alloc(0)).toString('utf8');
    const m = src.match(/^\s*\/\*[\s\S]*?END LICENSE BLOCK[\s\S]*?\*\//);
    const code = esbuild.transformSync(src, { minify: true, legalComments: 'none', logLevel: 'silent' }).code;
    return (m ? m[0].trim() + '\n' : '') + code;
  };
  for (const rel of tracked.filter((f) => /^core\/lib\/ace\/[^/]+$/.test(f))) {
    const f = rel.slice('core/lib/ace/'.length);
    if (f === 'lively-ace.js' || /^mode-.*\.js$/.test(f) || /^ace\..*\.js$/.test(f)) put(rel, minified(rel));
  }
  copy('core/lib/ace/LICENSE');
  for (const d of ONDEMAND_LIBS) copyDir(d);
  for (const f of ONDEMAND_FILES) copy(f);
  copy('core/media/lively.ico');
  // the identity vault page (vault.html, written by build.js) runs this file and libsodium, neither of which a plain boot loads
  copy('core/lively/identity/IdentityVaultFrame.js');
  copy('core/lib/libsodium/sodium.js');
  // files the shipped stylesheets point at with url(...) (fonts, mostly); they load lazily, after boot, so the boot
  // inventory does not list them
  const have = new Set(list);
  for (const css of list.filter((f) => f.endsWith('.css'))) {
    const text = (read(css) || Buffer.alloc(0)).toString('utf8');
    for (const m of text.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g)) {
      if (/^(data:|https?:|\/\/|#)/.test(m[1])) continue;
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(css), m[1].split(/[?#]/)[0]));
      if (have.has(rel)) continue;
      have.add(rel);
      if (isTracked.has(rel)) copy(rel); else console.warn('css refers to a file the kernel does not track: ' + css + ' -> ' + rel);
    }
  }
  // directories the runtime lists with PROPFIND: ship every file in them
  for (const d of LISTED_DIRS) copyDir(d);

  // 2. what the kernel's server would generate: the boot bundle, made by the kernel's own code (see kernel-bundle.js)
  const { hash, code } = await buildBundle(REPO, path.join(ROOT, '.cache'));
  put('generated/combinedModulesHash.txt', hash);
  put('generated/' + hash + '/combinedModules.js', code);

  // 3. the world's document as committed (build.js turns it into world.html), and the notices that must travel with the code
  // The one file that is not copied verbatim. blank.html is a saved world, and it records the directories its author last
  // worked in (local paths that include a user name). That list is a convenience of one tool and is empty in a fresh world,
  // so it is emptied here; anything else that looks like a local path stops the refresh instead of being published.
  const blank = git('show HEAD:blank.html').toString('utf8').replace(/"knownWorkingDirectories":\[[^\]]*\]/, '"knownWorkingDirectories":[]');
  const localPath = blank.match(/(?:\/mnt\/[a-z]|[A-Za-z]:)?[\/\\](?:Users|home)[\/\\][^\/\\"'\s]+/);
  if (localPath) problems.push('blank.html carries what looks like a local path: ' + localPath[0]);
  put('blank.html', blank);
  copy('LICENSE');
  copy('AUTHORS');

  if (problems.length) { console.error(problems.join('\n') + '\nnothing was written'); process.exit(1); }

  const commit = git('rev-parse HEAD').toString('utf8').trim();
  put('SNAPSHOT.json', JSON.stringify({ v: 1, commit, bundleHash: hash }, null, 2) + '\n');
  // The one file in kernel/ that is written by hand (what is known about the vendored libraries' licences); it is not the
  // kernel's, so it survives the rewrite. Without it a refresh would delete the only record of what has not been audited.
  const notices = path.join(DEST, 'THIRD-PARTY-NOTICES.md');
  if (!fs.existsSync(notices)) { console.error('kernel/THIRD-PARTY-NOTICES.md is missing; it is kept by hand and a refresh does not recreate it'); process.exit(1); }
  put('THIRD-PARTY-NOTICES.md', fs.readFileSync(notices));
  fs.rmSync(DEST, { recursive: true, force: true });
  let bytes = 0;
  for (const [rel, data] of [...out].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const p = path.join(DEST, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); bytes += data.length;
  }
  console.log('kernel/ refreshed from ' + commit.slice(0, 7) + ': ' + out.size + ' files, ' + bytes + ' bytes, bundle ' + hash);
})().catch((e) => { console.error(e); process.exit(1); });
