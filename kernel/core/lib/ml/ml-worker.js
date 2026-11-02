/**
 * core/lib/ml/ml-worker.js
 *
 * Hand-written Worker entry point for the wiki's ML (Standard ML) code cells. Runs in a dedicated Worker;
 * core/lively/identity/MLWorker.js owns exactly one per wiki page (every ML cell on the page shares its interpreter).
 * The engine is the committed bundle ml-engine.js (rebuilt with `npm run build:ml`), which defines MLEngine.
 *
 * Protocol (postMessage, plain JSON-able objects), the same as scheme-worker.js minus input and #lang:
 *   in:  {op:'init'}
 *   out: {op:'init', ok:true, buildId} | {op:'init', ok:false, error}
 *   in:  {id, op:'run', source}
 *   out: {id, op:'segments', segments:[{kind, text, ...}]}   (zero or more; new output since the last message)
 *        {id, op:'done', state, segments:[...]}              (state: done | error | stopped)
 *   in:  {op:'interrupt'}                                    (cooperative: seen between time slices, the
 *                                                             environment survives)
 *   in:  {op:'reset'}                                        (fresh interpreter; the worker stays alive)
 *   out: {op:'reset', ok:true}
 */

'use strict';

importScripts('/core/lib/ml/ml-engine.js');

var SLICE_MS = 25;

var interp = null;
var job = null;           // the run in flight, or null
var jobId = null;

// A MessageChannel round trip between slices (setTimeout gets clamped once nested) so a pending interrupt message is
// seen promptly.
var yieldChannel = new MessageChannel();
var yieldCallback = null;
yieldChannel.port1.onmessage = function () {
  var cb = yieldCallback;
  yieldCallback = null;
  if (cb) cb();
};
function yieldThen(cb) {
  yieldCallback = cb;
  yieldChannel.port2.postMessage(0);
}

function ensureInterpreter() {
  if (!interp) interp = MLEngine.createInterpreter();
  return interp;
}

function finishRun(id, state, segments) {
  job = null;
  jobId = null;
  postMessage({ id: id, op: 'done', state: state, segments: segments || [] });
}

function pump(myJob, myId) {
  if (job !== myJob) return;   // dropped by reset
  var r;
  try {
    r = myJob.step(SLICE_MS);
  } catch (e) {
    finishRun(myId, 'error', [{ kind: 'error', errorClass: 'internal', text: 'Internal error: ' + (e && e.message ? e.message : e) }]);
    return;
  }
  if (r.state === 'running') {
    if (r.segments.length) postMessage({ id: myId, op: 'segments', segments: r.segments });
    yieldThen(function () { pump(myJob, myId); });
  } else {
    finishRun(myId, r.state, r.segments);
  }
}

onmessage = function (evt) {
  var msg = evt.data;
  switch (msg.op) {
    case 'init':
      try {
        ensureInterpreter();
        postMessage({ op: 'init', ok: true, buildId: MLEngine.buildId });
      } catch (e) {
        postMessage({ op: 'init', ok: false, error: String(e && e.message || e) });
      }
      break;
    case 'run':
      if (job) {
        postMessage({ id: msg.id, op: 'done', state: 'error',
          segments: [{ kind: 'error', errorClass: 'internal', text: 'Another ML cell is still running.' }] });
        break;
      }
      job = ensureInterpreter().startRun(msg.source);
      jobId = msg.id;
      pump(job, jobId);
      break;
    case 'interrupt':
      if (job) job.interrupt();
      break;
    case 'reset':
      job = null;
      jobId = null;
      interp = MLEngine.createInterpreter();
      postMessage({ op: 'reset', ok: true });
      break;
  }
};
