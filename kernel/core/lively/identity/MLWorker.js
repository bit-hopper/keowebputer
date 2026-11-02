/**
 * lively.identity.MLWorker
 *
 * Client-side controller for the wiki's ML (Standard ML) code cells: one raw
 * `new Worker('/core/lib/ml/ml-worker.js')` per wiki page, created lazily on the first ML Run click (never on page load),
 * shared by every ML cell on the page. All of the behaviour lives in lively.identity.CodeCellWorker, which this is an
 * instance of. ML cells never ask for input, so the input half of the controller is simply never used.
 */

module('lively.identity.MLWorker')
  .requires('lively.identity.CodeCellWorker')
  .toRun(function () {

    lively.identity.MLWorker = lively.identity.CodeCellWorker.create({
      name: 'ML',
      workerUrl: '/core/lib/ml/ml-worker.js',
      path: 'lively.identity.MLWorker',
    });

  });
