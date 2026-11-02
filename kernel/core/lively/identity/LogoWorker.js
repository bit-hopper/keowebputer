/**
 * lively.identity.LogoWorker
 *
 * Client-side controller for the wiki's Logo and TPN code cells (LOGO.md 7.2): one raw
 * `new Worker('/core/lib/logo/logo-worker.js')` per wiki page, created lazily on the first Logo Run click (never on page
 * load). Both the `logo` and the `tpn` registry rows name this one controller, so a procedure defined in a tpn cell is
 * callable from a logo cell and every Logo or TPN cell on the page shares one interpreter. All of the behaviour lives in
 * lively.identity.CodeCellWorker, which this is an instance of. What is Logo's own is the `onDraw(ops, turtle)` handler
 * (the turtle's drawing, delivered ahead of the same slice's text); see core/lib/logo/logo-worker.js for the protocol.
 * The worker does not post `needInput` yet: the engine has no READ* primitives.
 */

module('lively.identity.LogoWorker')
  .requires('lively.identity.CodeCellWorker')
  .toRun(function () {

    lively.identity.LogoWorker = lively.identity.CodeCellWorker.create({
      name: 'Logo',
      workerUrl: '/core/lib/logo/logo-worker.js',
      path: 'lively.identity.LogoWorker',
      sendLanguage: true,   // the worker tells `logo` from `tpn` cells by the run message's language
    });

  });
