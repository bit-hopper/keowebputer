/**
 * lively.identity.SchemeWorker
 *
 * Client-side controller for the wiki's Scheme code cells: one raw
 * `new Worker('/core/lib/scheme/scheme-worker.js')` per wiki page, created lazily on the first Scheme Run click (never on
 * page load), shared by every Scheme cell on the page. All of the behaviour (two-tier Stop, one run at a time, streamed
 * segments, input requests) lives in lively.identity.CodeCellWorker, which this is an instance of. Scheme cells may pause
 * to ask for a line of input (onNeedInput / provideInput).
 */

module('lively.identity.SchemeWorker')
  .requires('lively.identity.CodeCellWorker')
  .toRun(function () {

    lively.identity.SchemeWorker = lively.identity.CodeCellWorker.create({
      name: 'Scheme',
      workerUrl: '/core/lib/scheme/scheme-worker.js',
      path: 'lively.identity.SchemeWorker',
    });

  });
