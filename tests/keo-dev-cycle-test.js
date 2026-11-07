// extension/dev-cycle.js against throwaway repositories (no browser, no real kernel): it commits only the files it is told to, leaves every
// other change alone, amends its own unpushed commit but never a pushed or a real one, refuses paths that could name something else, and
// keeps the clean clone a clone it may reset, with the kernel's packages linked in and never touched.
// Usage: node tests/keo-dev-cycle-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { commitPaths, syncClean, cleanPath, WIP } = require('../extension/dev-cycle.js');

let passed = 0, failed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 400) : '')); }
const git = (cwd, args) => { const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr); return r.stdout.trim(); };
// not trimmed: the first status line starts with a space when the file is changed but not staged
const status = (cwd) => cp.spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).stdout;
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
const write = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const names = (cwd, rev) => git(cwd, ['show', '--name-only', '--format=', rev || 'HEAD']).split('\n').filter(Boolean).sort();
const count = (cwd) => Number(git(cwd, ['rev-list', '--count', 'HEAD']));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'keo-devcycle-'));
const K = path.join(T, 'kernel'), CLEAN = path.join(T, 'clean'), REMOTE = path.join(T, 'remote.git');
try {
  // ---- the kernel: a base commit, a marker in node_modules, and a bare "remote"
  fs.mkdirSync(K); git(K, ['init', '-q', '-b', 'main']);
  for (const [k, v] of [['user.name', 'Tester'], ['user.email', 'tester@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(K, ['config', k, v]);
  write(K, 'a.txt', 'a0\n'); write(K, 'b.txt', 'b0\n'); write(K, 'c/d.txt', 'd0\n');
  write(K, '.gitignore', 'node_modules/\n');
  git(K, ['add', '.']); git(K, ['commit', '-q', '-m', 'base']);
  write(K, 'node_modules/marker.txt', 'the kernel packages\n');
  fs.mkdirSync(REMOTE); git(REMOTE, ['init', '-q', '--bare', '-b', 'main']);

  // ---- paths that could name something else are refused before anything is touched
  for (const bad of ['../x', '/etc/passwd', 'C:\\x', '-f', '', 'a/../../x']) check('refused as a path: ' + JSON.stringify(bad), !!throws(() => cleanPath(bad)));
  check('refused: nothing named', /Nothing to commit/.test(throws(() => commitPaths(K, [])) || ''));
  check('refused: a file that has not changed', /Nothing has changed in a\.txt/.test(throws(() => commitPaths(K, ['a.txt'])) || ''));
  check('refused: a file that is not there', /Nothing has changed/.test(throws(() => commitPaths(K, ['nope.txt'])) || ''));
  check('nothing was committed by those refusals', count(K) === 1);

  // ---- only the named files are committed; every other change stays where it was
  write(K, 'a.txt', 'a1\n'); write(K, 'n.txt', 'new\n');            // named: one changed, one new
  write(K, 'b.txt', 'b1 (not mine)\n');                              // changed, not named
  write(K, 'c/d.txt', 'd1 (staged, not mine)\n'); git(K, ['add', 'c/d.txt']);
  const r1 = commitPaths(K, ['a.txt', 'n.txt'], 'first');
  check('a WIP commit is made, with the files named and no others', !r1.amended && names(K).join() === 'a.txt,n.txt' && git(K, ['log', '-1', '--format=%s']).startsWith(WIP), names(K));
  check('the change that was not named is still a change, unstaged', /^ M b\.txt$/m.test(status(K)) && fs.readFileSync(path.join(K, 'b.txt'), 'utf8') === 'b1 (not mine)\n');
  check('the change that was staged and not named is still staged, and not in the commit', /^M  c\/d\.txt$/m.test(status(K)));

  // ---- a second run amends its own unpushed WIP commit
  const before = count(K);
  write(K, 'a.txt', 'a2\n');
  const r2 = commitPaths(K, ['a.txt']);
  check('the next run amends the WIP commit instead of adding another', r2.amended && count(K) === before && names(K).join() === 'a.txt,n.txt' && git(K, ['show', 'HEAD:a.txt']) === 'a2', { r2, names: names(K) });
  check('and still leaves the others alone', /^ M b\.txt$/m.test(status(K)) && /^M  c\/d\.txt$/m.test(status(K)));

  // ---- a WIP commit that has been pushed is never rewritten
  git(K, ['remote', 'add', 'origin', REMOTE]); git(K, ['push', '-q', '-u', 'origin', 'main']);
  const pushedHead = git(K, ['rev-parse', 'HEAD']), n0 = count(K);
  write(K, 'a.txt', 'a3\n');
  const r3 = commitPaths(K, ['a.txt']);
  check('a pushed WIP commit is left as it is: a new commit is made', !r3.amended && count(K) === n0 + 1 && git(K, ['rev-parse', 'HEAD~1']) === pushedHead, r3);

  // ---- a real commit is never amended either
  git(K, ['commit', '-q', '--amend', '-m', 'A real message', '--only', '--', 'a.txt']);
  const n1 = count(K), realHead = git(K, ['rev-parse', 'HEAD']);
  write(K, 'a.txt', 'a4\n');
  const r4 = commitPaths(K, ['a.txt']);
  check('a commit that is not a WIP one is left as it is: a new commit is made', !r4.amended && count(K) === n1 + 1 && git(K, ['rev-parse', 'HEAD~1']) === realHead, r4);

  // ---- the clean clone
  check('the clean clone cannot be the kernel itself', /must not be the kernel checkout/.test(throws(() => syncClean(K, K)) || ''));
  const head = syncClean(K, CLEAN);
  check('the clean clone is made at the kernel commit, with its line endings left alone', head === git(K, ['rev-parse', 'HEAD']) && git(CLEAN, ['config', 'core.autocrlf']) === 'false', head);
  check('the kernel packages are linked in, not copied', fs.lstatSync(path.join(CLEAN, 'node_modules')).isSymbolicLink() && fs.readFileSync(path.join(CLEAN, 'node_modules', 'marker.txt'), 'utf8') === 'the kernel packages\n');
  write(CLEAN, 'a.txt', 'dirt in the clean clone\n'); write(CLEAN, 'stray.txt', 'x');
  write(K, 'a.txt', 'a5\n'); commitPaths(K, ['a.txt']);
  const head2 = syncClean(K, CLEAN);
  check('moving it again follows the kernel and drops what was changed in it', head2 === git(K, ['rev-parse', 'HEAD']) && fs.readFileSync(path.join(CLEAN, 'a.txt'), 'utf8') === 'a5\n' && git(CLEAN, ['status', '--porcelain', '--untracked-files=no']) === '', head2);
  const plain = path.join(T, 'not-a-clone'); fs.mkdirSync(plain);
  check('a folder that is not a clone is refused, not reset', /Not a git clone/.test(throws(() => syncClean(K, plain)) || ''));
  git(K, ['checkout', '-q', '--detach']);
  check('a kernel on a detached commit is refused', /detached/.test(throws(() => syncClean(K, CLEAN)) || ''));
  git(K, ['checkout', '-q', 'main']);
} finally {
  // the link goes first, by itself, so removing the rest can never reach the kernel's packages through it
  try { const l = path.join(CLEAN, 'node_modules'); if (fs.lstatSync(l).isSymbolicLink()) { try { fs.rmdirSync(l); } catch (e) { fs.unlinkSync(l); } } } catch (e) {}
  fs.rmSync(T, { recursive: true, force: true });
  check('cleaning up left no trace of the throwaway repositories', !fs.existsSync(T));
}
console.log(`\n${passed} checks passed${failed ? ', ' + failed + ' FAILED' : ''}`);
process.exit(failed ? 1 : 0);
