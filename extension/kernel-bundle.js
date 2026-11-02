// Produce the kernel's boot bundle (generated/<hash>/combinedModules.js) without its dev server.
// The kernel builds the bundle inside core/servers/OptimizedLoadingServer.js and only exposes it as two HTTP routes. This
// loads that very file in this process with a stand-in `app`, then calls the two route handlers with stand-in responses, so
// the bundle is made by the kernel's own code and can not drift from it.
// Needs the kernel's node_modules (babel, source-map-concat, lively-loader, lively.lang); nothing is started or listened on.
// Must not be used to serve anything: the stand-in app answers only the two bundle routes.
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');

// The kernel writes its transpile cache and combined.js under the root it is given. Give it a root of our own whose
// core/ and node_modules/ are links to the kernel's, so building the package never writes into a checkout that a dev server
// is serving from.
function prepareRoot(kernel, cacheDir) {
  const root = path.join(cacheDir, 'kernel-root');
  fs.mkdirSync(root, { recursive: true });
  for (const name of ['core', 'apps', 'node_modules']) {
    const link = path.join(root, name), target = path.join(kernel, name);
    let current = null; try { current = fs.readlinkSync(link); } catch (e) {}
    if (current !== null && path.resolve(current) === path.resolve(target)) continue;
    if (current !== null) fs.unlinkSync(link);
    fs.symlinkSync(target, link, 'junction');   // 'junction' needs no privilege where symlinks are restricted, and is ignored elsewhere
  }
  return root;
}

// Resolves to { hash, code } (code is the bundle text).
async function buildBundle(kernel, cacheDir) {
  const root = prepareRoot(kernel, cacheDir);
  process.env.WORKSPACE_LK = root;
  const req = (m) => require(require.resolve(m, { paths: [root] }));
  if (typeof global.lively === 'undefined' || !global.lively.Config) {
    await new Promise((resolve, reject) => req('lively-loader').withLivelyNamespaceDo((err, lively) => {
      if (err) return reject(err);
      global.lively = lively; resolve();
    }));
  }
  const routes = {};
  require(path.join(root, 'core/servers/OptimizedLoadingServer.js'))('/', {
    get: (route, handler) => { routes[route] = handler; }
  });
  // a real Writable, because the handler streams the file with fs.createReadStream(...).pipe(res)
  const call = (route, params) => new Promise((resolve, reject) => {
    const chunks = []; let status = 200;
    const res = new Writable({ write(c, enc, cb) { chunks.push(Buffer.from(c)); cb(); } });
    res.status = (s) => { status = s; return res; };
    res.writeHead = (s) => { status = s; return res; };
    res.on('finish', () => status === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(route + ' -> ' + status + ' ' + Buffer.concat(chunks))));
    routes[route]({ params, headers: {} }, res);
  });
  const hash = String(await call('/generated/combinedModulesHash.txt')).trim();
  const code = await call('/generated/:hash/combinedModules.js', { hash });   // no accept-encoding: the plain file
  return { hash, code };
}

module.exports = { buildBundle };
