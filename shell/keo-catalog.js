// keo catalogue lookups, SHELL side: the one outside address the world may ask the shell to read for it. Music's catalogue (search and
// lookup of albums and songs) sends no cross-origin permission to the world, whose origin is opaque, so the browser refuses its
// answers there; the shell page can read them because the extension manifest has host permission for exactly that site
// (host_permissions in extension/build.js). The world asks through the bridge op catalog.get and gets plain data back.
//
// What this is NOT: a general fetch. Only a GET of https://itunes.apple.com/search or /lookup is made, with no cookies, no referrer and
// no redirects followed, the answer must be JSON of at most MAX_BYTES, and it takes a signed-in session (shell.js checks that). The
// permission is wider than this check (the whole site), so this check is what keeps it narrow: do not loosen it, and do not add
// another host here without adding it to the manifest and to the README's account of what the package may reach.
(function () {
  'use strict';
  var HOST = 'itunes.apple.com';
  var PATHS = { '/search': true, '/lookup': true };
  var MAX_URL = 600, MAX_BYTES = 2 * 1024 * 1024, TIMEOUT_MS = 15000;

  // The address, parsed and checked, or an Error saying what is wrong with it.
  function checked(url) {
    if (typeof url !== 'string' || url.length > MAX_URL) throw new Error('That is not a valid catalogue address.');
    var u;
    try { u = new URL(url); } catch (e) { throw new Error('That is not a valid catalogue address.'); }
    if (u.protocol !== 'https:' || u.hostname !== HOST || u.port !== '' || u.username || u.password || u.hash || !PATHS[u.pathname]) {
      throw new Error('That address is not one the catalogue lookup may read.');
    }
    return u;
  }

  // Resolves to the parsed JSON of the answer.
  async function get(args) {
    var u = checked(args && args.url);
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
    try {
      var res = await fetch(u.href, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', signal: ctl.signal });
      if (!res.ok) throw new Error('The catalogue answered HTTP ' + res.status + '.');
      var buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BYTES) throw new Error('The catalogue answer is too large.');
      try { return JSON.parse(new TextDecoder().decode(buf)); }
      catch (e) { throw new Error('The catalogue answer was not valid JSON.'); }
    } finally { clearTimeout(timer); }
  }

  window.keoCatalog = { get: get, check: checked };
})();
