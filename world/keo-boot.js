// keo boot: load the Lively bootstrap only after the shell has answered the bridge handshake, so
// everything the bootstrap and the first modules read at start (localStorage, the IndexedDB-backed identity record, ...)
// is already in place. The bootstrap is added as a script element: it finds its own URL among the page's scripts to work
// out the code base, which a dynamically added script satisfies just like the static tag it replaces.
//
// The handshake also says how to start (init.startup, decided by the shell's sign-in screen, see shell/keo-gate.js):
//   guest     the document as it is: the blank world
//   world     a saved world: its serialized data replaces the blank world's in this document, before the bootstrap reads it
//   homestar  a new identity (nothing saved yet): the blank world, then the identity's home page opened on it
// and, once the world is up, what a save and a move between pages do here. Saved worlds live in the shell, encrypted under
// the signed-in identity (shell/keo-worlds.js); this file only asks for them and never sees a key.
(function () {
  'use strict';
  var keo = window.keo;

  // The bootstrap decides whether the page has finished loading when it RUNS: readyState "complete" or "loaded", else it waits for
  // the DOMContentLoaded event. Added from here (after the handshake) it can run after that event has fired but before the
  // state is "complete": it then waits for an event that already happened and the world never starts, with no error (seen as
  // about one restart in five). So it is added only once the page is complete.
  function go() {
    function add() {
      var s = document.createElement('script');
      s.type = 'text/javascript';
      s.src = 'core/lively/bootstrap.js';
      document.body.appendChild(s);
    }
    if (document.readyState === 'complete') add();
    else window.addEventListener('load', add, { once: true });
  }

  // A saved page is a whole document; the world is the text of its x-lively-world script. Copying that text (and the
  // migration level next to it) into this page's own script element makes the runtime load the saved world as if this page
  // had been saved. Stops, and leaves the blank world, if the saved page has no such element.
  function applySavedWorld(doc) {
    var saved = new DOMParser().parseFromString(String(doc), 'text/html').querySelector('script[type="text/x-lively-world"]');
    var mine = document.querySelector('script[type="text/x-lively-world"]');
    if (!saved || !mine) throw new Error('the saved page holds no world');
    mine.textContent = saved.textContent;
    var level = saved.getAttribute('data-migrationlevel');
    if (level !== null) mine.setAttribute('data-migrationlevel', level);
  }

  // ---- once the world is running ----
  // The package's own page is world.html, which is called "world"; saving "the world" from a world that was opened by name
  // keeps that name. `worlds` is a copy of the shell's list for the menu (a menu cannot wait for an answer).
  var local = { current: null, worlds: [], page: null };
  // What a page here is called when it is saved: the file name the runtime asks for, without its extension.
  function nameFromUrl(url) {
    var m = /([^/?#]+?)(.[A-Za-z]*html)?(?:[?#].*)?$/.exec(String(url));
    var n = (m && m[1]) || 'world';
    return n === 'world' && local.current ? local.current : n;
  }
  function refreshList() {
    return window.keo.call('world.list').then(function (l) { local.worlds = l; }, function () { local.worlds = []; });
  }
  function navigate(args) { window.keo.call('world.go', args, 120000).catch(function (e) { $world.inform(String(e && e.message || e)); }); }

  // Replaces how the runtime stores a saved page: instead of a PUT to a server it asks the shell, which encrypts it under the
  // signed-in identity. Without a session the shell refuses and the person is told so. Everything the original did after a
  // good save that needs a server (reading the revision back, offering to visit the new address) is left out on purpose.
  function installSave() {
    var W = lively.morphic.World.prototype, saveAs = W.saveWorldAs;
    // The home page is built fresh on every visit, so a saved copy of it would be frozen morphs with nothing behind them. This
    // has to be refused BEFORE the runtime serializes the page: serializing the home page took the whole tab down in testing.
    // The completion callback is the last function among the arguments (the runtime lets some be left out).
    W.saveWorldAs = function () {
      if (local.page !== 'homestar') return saveAs.apply(this, arguments);
      var args = Array.prototype.slice.call(arguments), cb = args.filter(function (a) { return typeof a === 'function'; }).pop();
      var e = new Error('This is your home page, which is rebuilt each time. Start a new blank world (keo > New blank world) to save one.');
      this.inform(e.message);
      if (cb) cb(e);
    };
    // Saving under another name asks the server whether the folder exists and offers to create it; there is no folder here.
    W.checkIfPathExistsAndStoreDoc = function (doc, url, checkForOverwrites, thenDo) { this.storeDoc(doc, url, checkForOverwrites, thenDo); };
    W.storeDoc = function (doc, url, checkForOverwrites, thenDo) {
      var world = this, name = nameFromUrl(url);
      window.keo.call('world.save', { name: name, doc: doc }, 120000).then(function (r) {
        local.current = r.name;
        refreshList();
        lively.bindings.signal(world, 'savingDone', url);
        if (lively.Config.get('showWorldSave')) world.alertOK('World saved: ' + r.name);
        if (thenDo) thenDo(null);
      }, function (err) {
        world.inform('Could not save "' + name + '": ' + (err && err.message || err));
        if (thenDo) thenDo(err);
      });
    };
  }

  // A keo entry at the top of the world's context menu: the places a signed-in person can go and a way to name a save. The list
  // of saved worlds is a copy refreshed after load and after each save (a menu cannot wait for an answer).
  function installMenu() {
    var W = lively.morphic.World.prototype, orig = W.morphMenuItems;
    W.morphMenuItems = function () {
      var items = orig.apply(this, arguments);
      var opens = local.worlds.map(function (w) { return [w.name + (w.last ? '  (last)' : ''), function () { navigate({ kind: 'world', name: w.name }); }]; });
      var keoItems = [
        ['Home page', function () { navigate({ kind: 'homestar' }); }],
        ['New blank world', function () { navigate({ kind: 'blank' }); }],
        ['Save world as ...', function () {
          $world.prompt('Save this world on this device as:', function (name) {
            if (name && name.trim()) $world.saveWorldAs(URL.root.withFilename(name.trim() + '.html'), false);
          }, local.current || '');
        }],
        ['Open', opens.length ? opens : [['(nothing saved yet)', function () {}]]]
      ];
      return [['keo', keoItems]].concat(items);
    };
  }

  // The shell holds the session; the runtime's identity module (menu bar, ambient panel, ...) only knows its own server
  // sessions, so show it the shell's. Both modules are needed first: the menu entry calls LocalIdentity.
  function syncSession(session) {
    lively.require('lively.identity.LocalIdentity').toRun(function () {
      lively.require('lively.identity.DID').toRun(function () {
        if (lively.identity.did.setLocalSession) lively.identity.did.setLocalSession(session);
      });
    });
  }

  // The identity's home page. The runtime's page takes a handle, which only a host grants; a local identity has none, so the
  // DID stands in for it in addresses and the person's own label is what is shown.
  // A theme applied to the home page is kept with the identity's settings and applied again on the next visit; the home page
  // is never saved as a world, so this is the only way it persists. Themes of saved worlds stay with the world (the runtime
  // keeps them in the page it saves).
  function rememberHomeTheme() {
    lively.require('lively.morphic.Themes').toRun(function () {
      var T = lively.morphic.Themes, apply = T.apply, clear = T.clear;
      T.apply = function (name) { apply.apply(T, arguments); if (local.page === 'homestar') window.keo.call('prefs.set', { key: 'homeTheme', value: String(name) }).catch(function () {}); };
      T.clear = function () { clear.apply(T, arguments); if (local.page === 'homestar') window.keo.call('prefs.set', { key: 'homeTheme', value: null }).catch(function () {}); };
    });
  }
  function applyHomeTheme(name) {
    if (!name) return;
    lively.require('lively.morphic.Themes').toRun(function () {
      var w = $world, ok = w.alertOK;
      w.alertOK = function () {};           // the runtime's "applied, save the world to keep it" does not apply here
      try { if (lively.morphic.Themes.registry[name]) lively.morphic.Themes.apply(name, w); } finally { w.alertOK = ok; }
    });
  }

  function openHomestar(session, warning) {
    lively.require('lively.identity.Homestar').toRun(function () {
      lively.identity.Homestar.open({
        handle: session.did, displayHandle: session.label, did: session.did,
        viewer: { handle: session.did, did: session.did }, isOwner: true, profile: { displayName: session.label }
      });
      if (warning) $world.inform(warning);
      window.keo.call('prefs.get').then(function (p) { applyHomeTheme(p && p.homeTheme); }, function () {});
    });
  }

  // The runtime's own "world is loaded" queue (lively.whenLoaded) exists before its configuration does, and a callback queued
  // that early fails. So poll for the loaded world itself, the way the tests do, and install once it is there.
  function afterLoad(startup) {
    var tries = 0;
    (function wait() {
      if (window.$world && window.$world.submorphs && window.lively && lively.morphic && lively.morphic.World) {
        local.page = startup && startup.kind;
        installSave();
        installMenu();
        rememberHomeTheme();
        if (startup && startup.session) syncSession(startup.session);
        if (startup && startup.kind === 'world') local.current = startup.name;
        refreshList();
        if (startup && startup.kind === 'homestar') openHomestar(startup.session, startup.warning);
        return;
      }
      if (++tries < 1200) setTimeout(wait, 100);
    })();
  }

  if (!keo) return go();
  keo.ready.then(function (init) {
    var startup = init && init.startup;
    if (startup && startup.kind === 'gate') {
      // Nobody is signed in: start from the package's own landing page (a saved world shipped as gate-world.html), whose
      // buttons sign in or create an identity through the shell. Falls back to the blank world if it is not there.
      try {
        var x = new XMLHttpRequest();
        x.open('GET', 'gate-world.html', false);
        x.send(null);
        if (x.status !== 200 && x.status !== 0) throw new Error('HTTP ' + x.status);
        // The page names its pictures as uploads on some host; here they are files of the package, so make those addresses
        // relative to the package (the world works with no network).
        applySavedWorld(x.responseText.replace(/https?:\/\/[^"\\\/]+(?=\/users\/[^"\\]+\/uploads\/)/g, ''));
      } catch (e) { console.warn('keo: the landing page could not be loaded (' + e.message + ')'); }
    } else if (startup && startup.kind === 'world') {
      try { applySavedWorld(startup.doc); }
      catch (e) { console.warn('keo: starting the blank world (' + e.message + ')'); startup = { kind: 'homestar', session: startup.session, warning: 'Your saved world could not be opened.' }; }
    }
    go();
    afterLoad(startup);
  }, function (e) {
    console.warn('keo: starting without the shell\'s storage (' + e.message + ')');
    go();
  });
})();
