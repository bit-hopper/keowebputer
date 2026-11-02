// The files of a built package and their hashes, for keo-files.json (written by the build) and for the signing tool.
// Both must hash exactly the same set, which is why it is one function. Run from Node only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Not part of what a release describes: the builder's marker, and the file this list is written to.
const SKIP = new Set(['.keo-world-build', 'keo-files.json']);

// { 'core/lively/Foo.js': { sha256: <hex>, size: <bytes> }, ... } for every file under `dir`, with forward slashes.
function listPackage(dir) {
  const out = {};
  (function walk(rel) {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && !SKIP.has(r)) {
        const data = fs.readFileSync(path.join(dir, r));
        out[r] = { sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length };
      }
    }
  })('');
  return out;
}

module.exports = { listPackage };
