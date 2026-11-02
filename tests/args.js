// Argument handling shared by the browser tests: <repo root> <package folder> <work dir>.
// Browser profiles, screenshots and reports go in the work dir, so it must be given and must not be inside the repository
// (a mis-ordered argument once put a 230-file browser profile in the repo root). It is created if it does not exist.
// A relative path is taken from where the shell is, not from the test file.
const fs = require('fs');
const path = require('path');

const inside = (parent, child) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

module.exports = function testArgs(argv) {
  argv = argv || process.argv.slice(2);
  const die = (m) => { console.error(m + '\nusage: node tests/<test>.js <repo root> <package folder> <work dir>'); process.exit(2); };
  if (argv.length < 3) die('missing arguments (got ' + argv.length + ', need 3)');
  const [REPO, EXT, WORK] = argv.slice(0, 3).map((a) => path.resolve(a));
  if (!fs.existsSync(path.join(REPO, 'node_modules', 'playwright-core'))) die('no node_modules/playwright-core under the repo root: ' + REPO);
  if (!fs.existsSync(path.join(EXT, 'manifest.json'))) die('the package folder has no manifest.json (not a built package): ' + EXT);
  if (inside(REPO, WORK)) die('the work dir must be outside the repository: ' + WORK);
  if (inside(EXT, WORK)) die('the work dir must be outside the package folder: ' + WORK);
  fs.mkdirSync(WORK, { recursive: true });
  return { REPO, EXT, WORK };
};
