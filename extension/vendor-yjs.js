// Builds shell/keo-yjs.js: one plain script that holds the Yjs library (and the small library it is built on), so the shell can use it
// with no module system, no npm package at build time and no network. Run by hand when the copy is to be refreshed; the build itself
// (build.js) only copies the file it produced, so a package build needs none of this.
// Usage: node extension/vendor-yjs.js --yjs <folder of the yjs npm package> --esbuild <folder of the esbuild npm package>
// The yjs folder's own node_modules (or a parent's) must hold lib0, which is how npm lays it out. Nothing is installed or changed in
// either folder: they are only read. The versions are read from their package.json files and written into the file's first lines.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function opt(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const yjsDir = opt('--yjs') && path.resolve(opt('--yjs')), esbuildDir = opt('--esbuild') && path.resolve(opt('--esbuild'));
if (!yjsDir || !esbuildDir) { console.error('usage: node extension/vendor-yjs.js --yjs <yjs package folder> --esbuild <esbuild package folder>'); process.exit(1); }

const version = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
const yjsVersion = version(yjsDir), esbuildVersion = version(esbuildDir);
const esbuild = require(esbuildDir);

// lib0 sits beside yjs (npm hoists it) or inside it: find it the way the bundler will, and read its version for the header
function findLib0(from) {
  for (let d = from; ; d = path.dirname(d)) {
    for (const c of [path.join(d, 'node_modules', 'lib0'), path.join(d, 'lib0')]) if (fs.existsSync(path.join(c, 'package.json'))) return c;
    if (path.dirname(d) === d) throw new Error('lib0 was not found beside the yjs folder');
  }
}
const lib0Dir = findLib0(yjsDir), lib0Version = version(lib0Dir);

// The licence text of both libraries goes at the top of the file (they are MIT licensed: the notice must travel with the copy).
const licence = (dir) => fs.readFileSync(path.join(dir, fs.existsSync(path.join(dir, 'LICENSE')) ? 'LICENSE' : 'LICENSE.md'), 'utf8').trim();
const banner = '/*! keo-yjs.js: a built copy of Yjs ' + yjsVersion + ' with lib0 ' + lib0Version + ', unchanged apart from being bundled into one script.\n' +
  ' * Made by extension/vendor-yjs.js with esbuild ' + esbuildVersion + ' (iife, minified, global keoYjs; a require() of this file returns the same object).\n' +
  ' * Licence texts of both libraries follow; shell/THIRD-PARTY-NOTICES.md describes the file.\n *\n' +
  ' * ---- yjs ----\n' + licence(yjsDir).split('\n').map((l) => ' * ' + l).join('\n') + '\n *\n' +
  ' * ---- lib0 ----\n' + licence(lib0Dir).split('\n').map((l) => ' * ' + l).join('\n') + '\n */';

const entry = path.join(yjsDir, 'dist', 'yjs.mjs');
const out = path.join(__dirname, '..', 'shell', 'keo-yjs.js');
const result = esbuild.buildSync({
  stdin: { contents: "export * from " + JSON.stringify(entry.replace(/\\/g, '/')) + ";", resolveDir: yjsDir, sourcefile: 'keo-yjs-entry.js' },
  bundle: true, minify: true, format: 'iife', globalName: 'keoYjs', platform: 'browser', target: 'es2020', legalComments: 'none', write: false,
  banner: { js: banner },
  footer: { js: 'if (typeof module === "object" && module.exports) module.exports = keoYjs;' }
});
if (result.errors.length) { console.error(result.errors); process.exit(1); }
const text = result.outputFiles[0].text;
fs.writeFileSync(out, text);
console.log('wrote ' + path.relative(process.cwd(), out) + ' (' + Buffer.byteLength(text) + ' bytes): yjs ' + yjsVersion + ', lib0 ' + lib0Version + ', esbuild ' + esbuildVersion);
