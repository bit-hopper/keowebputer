// The loop for changing the runtime: commit the kernel files you changed, move a clean clone to that commit, refresh kernel/ from the
// clone, and build a package. About fifteen seconds. It exists because the snapshot in kernel/ is a function of a COMMIT of the kernel
// repository (see refresh-kernel.js), so a change to a runtime file reaches a package only by way of that commit.
//
// Usage: node extension/dev-cycle.js --kernel <kernel checkout> --clean <clean clone> [--out <package folder>] [--paths <kernel file>...]
//   --kernel  the kernel checkout where the work is done (or $KEO_KERNEL).
//   --clean   a clone used only for refreshing (or $KEO_KERNEL_CLEAN). Made if it is not there, with line-ending conversion off and the
//             kernel's node_modules linked in. It is only ever moved to the kernel's commit with a hard reset, so keep nothing in it.
//   --out     build a package there afterwards (a short path, outside the repository, is best).
//   --paths   the kernel files (or folders) to commit, relative to the kernel root. Only these are committed: every other change in the
//             kernel checkout, staged or not, is left exactly as it is. Without --paths nothing is committed and the clean clone moves
//             to the commit the kernel is already on.
// What it does to the kernel repository: one LOCAL commit, "WIP keo: ...". A later run amends that commit instead of adding another, but
// only while it has not been pushed (it is not on any remote branch). It never pushes, never rewrites anything else, and never stages
// anything you did not name. When the change is finished, give the commit its real message (git commit --amend -m ...) and run it once
// more without --paths, so the snapshot names the final commit.
// Not for: committing for anyone else, a kernel checkout that holds work you want kept in a commit of its own (name those files in
// --paths only when they belong in this one), or any machine that must not run git hooks (they run, as for any commit).
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const WIP = 'WIP keo: ';

function git(cwd, args, opts) {
  const r = cp.spawnSync('git', args, Object.assign({ cwd, encoding: 'utf8' }, opts || {}));
  if (r.status !== 0 && !(opts && opts.allowFail)) throw new Error('git ' + args.join(' ') + ' failed in ' + cwd + ': ' + String(r.stderr || r.stdout || r.error).trim());
  return r;
}
const out = (cwd, args) => git(cwd, args).stdout.trim();

// A path is a file or folder INSIDE the kernel, spelled relative to its root; anything that could name something else is refused.
function cleanPath(p) {
  if (typeof p !== 'string' || !p || path.isAbsolute(p) || p.startsWith('-') || /(^|[\\/])\.\.([\\/]|$)/.test(p)) throw new Error('Not a path inside the kernel: ' + String(p));
  return p.replace(/\\/g, '/');
}

// Commits exactly `paths` in the kernel checkout. Returns { commit, amended }.
function commitPaths(kernel, paths, note) {
  if (!paths || !paths.length) throw new Error('Nothing to commit: name the kernel files with --paths.');
  const list = paths.map(cleanPath);
  for (const p of list) {
    if (!out(kernel, ['status', '--porcelain', '--', p])) throw new Error('Nothing has changed in ' + p + ' (is the name right, and relative to the kernel root?)');
  }
  git(kernel, ['add', '--', ...list]);                // new files have to be known to git before a commit by path can include them
  const subject = out(kernel, ['log', '-1', '--format=%s']);
  const pushed = out(kernel, ['branch', '-r', '--contains', 'HEAD']);
  let amended = false;
  if (subject.startsWith(WIP) && !pushed) { git(kernel, ['commit', '-q', '--amend', '--no-edit', '--', ...list]); amended = true; }
  else git(kernel, ['commit', '-q', '-m', WIP + (note || 'work in progress'), '--', ...list]);
  return { commit: out(kernel, ['rev-parse', '--short', 'HEAD']), amended };
}

// Makes the clean clone (if needed) and moves it to the kernel's current commit. Returns the full hash it is at.
function syncClean(kernel, clean) {
  const k = path.resolve(kernel), c = path.resolve(clean);
  if (k === c) throw new Error('The clean clone must not be the kernel checkout itself: it is hard-reset.');
  if (!fs.existsSync(c)) {
    fs.mkdirSync(path.dirname(c), { recursive: true });
    git(path.dirname(c), ['clone', '-q', '--shared', '-c', 'core.autocrlf=false', k, c]);
  } else if (!fs.existsSync(path.join(c, '.git'))) {
    throw new Error('Not a git clone, and not made here: ' + c);
  }
  // The refresh needs the kernel's installed packages. A link, never a copy, and never deleted by this script: removing a clone
  // that holds the link recursively would remove the kernel's own packages through it.
  const nm = path.join(c, 'node_modules'), knm = path.join(k, 'node_modules');
  if (!fs.existsSync(nm)) {
    if (!fs.existsSync(knm)) console.log('note: the kernel has no node_modules, so the refresh will fail until it is installed there');
    else fs.symlinkSync(knm, nm, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const branch = out(k, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') throw new Error('The kernel checkout is on a detached commit: check out a branch first.');
  git(c, ['fetch', '-q', k, branch]);
  git(c, ['reset', '-q', '--hard', 'FETCH_HEAD']);
  return out(c, ['rev-parse', 'HEAD']);
}

function parse(argv) {
  const o = { paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kernel' || a === '--clean' || a === '--out') o[a.slice(2)] = argv[++i];
    else if (a === '--paths') { while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) o.paths.push(argv[++i]); }
    else throw new Error('Unknown argument: ' + a);
  }
  o.kernel = o.kernel || process.env.KEO_KERNEL;
  o.clean = o.clean || process.env.KEO_KERNEL_CLEAN;
  if (!o.kernel) throw new Error('Say where the kernel checkout is: --kernel <folder> (or $KEO_KERNEL).');
  if (!o.clean) throw new Error('Say where the clean clone is: --clean <folder> (or $KEO_KERNEL_CLEAN).');
  return o;
}

function main() {
  const o = parse(process.argv.slice(2));
  if (o.paths.length) {
    const r = commitPaths(o.kernel, o.paths);
    console.log((r.amended ? 'amended' : 'committed') + ' ' + r.commit + ' in the kernel (local only; give it its real message when the change is finished)');
  }
  const head = syncClean(o.kernel, o.clean);
  console.log('clean clone at ' + head.slice(0, 7));
  const here = path.join(__dirname, '..');
  let r = cp.spawnSync(process.execPath, [path.join(__dirname, 'refresh-kernel.js'), '--kernel', path.resolve(o.clean)], { cwd: here, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
  if (o.out) { r = cp.spawnSync(process.execPath, [path.join(__dirname, 'build.js'), path.resolve(o.out)], { cwd: here, stdio: 'inherit' }); if (r.status !== 0) process.exit(r.status || 1); }
}

module.exports = { commitPaths, syncClean, cleanPath, WIP };
if (require.main === module) { try { main(); } catch (e) { console.error(e.message); process.exit(1); } }
