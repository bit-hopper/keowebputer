/**
 * core/lib/logo/logo-worker.js
 *
 * Hand-written Worker entry point for the wiki's Logo and TPN code cells. Runs in a dedicated Worker;
 * core/lively/identity/LogoWorker.js owns exactly one per wiki page (every logo and tpn cell on the page shares its
 * interpreter, LOGO.md decision 1). The engine is the committed bundle logo-engine.js (rebuilt with `npm run build:logo`),
 * which defines LogoEngine. Do not add engine behaviour here: it belongs in core/lib/logo/src and is exercised by
 * tests/logo. This file only owns the protocol and the time slicing.
 *
 * Protocol (postMessage, plain JSON-able objects), the same as ml-worker.js plus the turtle's `draw` (LOGO.md 7.1):
 *   in:  {op:'init'}
 *   out: {op:'init', ok:true, buildId} | {op:'init', ok:false, error}
 *   in:  {id, op:'run', source, language}                    (language: 'logo' | 'tpn', the cell's registry id; the
 *                                                             procedures the run defines record it as their dialect,
 *                                                             LOGO.md 4.4. Absent means 'logo')
 *   out: {id, op:'draw', ops:[...], turtle:{...}|null}       (zero or more, one per slice that drew or moved the turtle;
 *                                                             ops are the engine's draw operations, see
 *                                                             core/lib/logo/src/turtle.js; turtle is the turtle's state
 *                                                             when it changed. Always sent BEFORE the same slice's
 *                                                             segments / done, so a picture is never behind its text)
 *        {id, op:'segments', segments:[{kind, text, ...}]}   (zero or more; new output since the last message)
 *        {id, op:'done', state, segments:[...]}              (state: done | error | stopped | exit)
 *   in:  {op:'interrupt'}                                    (cooperative: seen between time slices, the workspace
 *                                                             survives)
 *   in:  {op:'reset'}                                        (fresh interpreter, empty picture state; the worker stays
 *                                                             alive)
 *   out: {op:'reset', ok:true}
 *
 * Not yet in this protocol: `needInput` / `input` (READLIST and friends; the engine has no READ* primitives yet), key and
 * mouse events (Phase 7), screen (text-screen) ops (Phase 6).
 */

'use strict';

importScripts('/core/lib/logo/logo-engine.js');

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
  if (!interp) interp = LogoEngine.createInterpreter();
  return interp;
}

function finishRun(id, state, segments) {
  job = null;
  jobId = null;
  postMessage({ id: id, op: 'done', state: state, segments: segments || [] });
}

// Posts the slice's drawing, if there is any, ahead of its text.
function postDraw(id, r) {
  if ((r.draw && r.draw.length) || r.turtle) postMessage({ id: id, op: 'draw', ops: r.draw || [], turtle: r.turtle || null });
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
  postDraw(myId, r);
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
        postMessage({ op: 'init', ok: true, buildId: LogoEngine.buildId });
      } catch (e) {
        postMessage({ op: 'init', ok: false, error: String(e && e.message || e) });
      }
      break;
    case 'run':
      if (job) {
        postMessage({ id: msg.id, op: 'done', state: 'error',
          segments: [{ kind: 'error', errorClass: 'internal', text: 'Another Logo cell is still running.' }] });
        break;
      }
      // Every run reports the turtle once, even if it does not move: the cell's pane is new and blank, and the turtle may
      // be anywhere after an earlier cell.
      ensureInterpreter().turtle.dirty = true;
      // The cell's language picks the surface syntax; a message without one (an older controller) is Logo.
      job = interp.startRun(msg.source, { onError: 'stop', dialect: msg.language === 'tpn' ? 'tpn' : 'logo' });
      jobId = msg.id;
      pump(job, jobId);
      break;
    case 'interrupt':
      if (job) job.interrupt();
      break;
    case 'reset':
      job = null;
      jobId = null;
      interp = LogoEngine.createInterpreter();
      postMessage({ op: 'reset', ok: true });
      break;
  }
};
