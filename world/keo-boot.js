// keo boot: load the Lively bootstrap only after the shell has answered the bridge handshake, so
// everything the bootstrap and the first modules read at start (localStorage, the IndexedDB-backed identity record, ...)
// is already in place. The bootstrap is added as a script element: it finds its own URL among the page's scripts to work
// out the code base, which a dynamically added script satisfies just like the static tag it replaces.
(function () {
  'use strict';
  function go() {
    var s = document.createElement('script');
    s.type = 'text/javascript';
    s.src = 'core/lively/bootstrap.js';
    document.body.appendChild(s);
  }
  var keo = window.keo;
  if (!keo) return go();
  keo.ready.then(go, function (e) {
    console.warn('keo: starting without the shell\'s storage (' + e.message + ')');
    go();
  });
})();
