/**
 * core/lib/scheme/scheme-worker.js
 *
 * Hand-written Worker entry point for the wiki's Scheme code cells. Runs in
 * a dedicated Worker; core/lively/identity/SchemeWorker.js owns exactly one
 * per wiki page (every Scheme cell on the page shares its interpreter).
 * The engine itself is the committed bundle scheme-engine.js (rebuilt with
 * `npm run build:scheme`), which defines SchemeEngine on the global scope.
 *
 * Protocol (postMessage, plain JSON-able objects):
 *   in:  {op:'init'}
 *   out: {op:'init', ok:true, buildId} | {op:'init', ok:false, error}
 *   in:  {id, op:'run', source}
 *   out: {id, op:'segments', segments:[{kind, text}]}    (zero or more; new output since the last message)
 *        {id, op:'needInput'}                            (the cell called read / read-line)
 *        {id, op:'done', state, segments:[...]}          (state: done | error | stopped | exit)
 *   in:  {op:'input', id, text}                          (text null = end of input)
 *   in:  {op:'interrupt'}                                (cooperative: seen between time slices, the
 *                                                         global environment survives)
 *   in:  {op:'reset'}                                    (fresh interpreter; the worker stays alive)
 *   out: {op:'reset', ok:true}
 *
 * A `#lang name` first line selects a per-book library: if the interpreter
 * doesn't have it yet it is fetched from prelude/<name>.scm first.
 */

'use strict';

importScripts('/core/lib/scheme/scheme-engine.js');

var SLICE_MS = 25;

var interp = null;
var job = null;           // the run in flight, or null
var jobId = null;
var waitingInput = false;

// A MessageChannel round trip between slices (setTimeout gets clamped once
// nested) so a pending interrupt / input message is seen promptly.
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
  if (!interp) interp = SchemeEngine.createInterpreter();
  return interp;
}

function finishRun(id, state, segments) {
  job = null;
  jobId = null;
  waitingInput = false;
  postMessage({ id: id, op: 'done', state: state, segments: segments || [] });
}

// Runs slices of the current job until it finishes, needs input, or is
// replaced (reset / a new run) while yielded.
function pump(myJob, myId) {
  if (job !== myJob) return;   // dropped by reset
  var r;
  try {
    r = myJob.step(SLICE_MS);
  } catch (e) {
    finishRun(myId, 'error', [{ kind: 'error', text: 'Internal error: ' + (e && e.message ? e.message : e) }]);
    return;
  }
  if (r.state === 'running') {
    if (r.segments.length) postMessage({ id: myId, op: 'segments', segments: r.segments });
    yieldThen(function () { pump(myJob, myId); });
  } else if (r.state === 'input') {
    if (r.segments.length) postMessage({ id: myId, op: 'segments', segments: r.segments });
    waitingInput = true;
    postMessage({ id: myId, op: 'needInput' });
  } else {
    finishRun(myId, r.state, r.segments);
  }
}

function startRun(id, source) {
  var it = ensureInterpreter();
  job = it.startRun(source);
  jobId = id;
  waitingInput = false;
  pump(job, id);
}

function handleRun(id, source) {
  if (job) {
    postMessage({ id: id, op: 'done', state: 'error',
      segments: [{ kind: 'error', text: 'Another Scheme cell is still running.' }] });
    return;
  }
  var it = ensureInterpreter();
  var lang = SchemeEngine.Parser.extractLang(source);
  if (lang && !it.hasLibrary(lang) && /^[A-Za-z0-9_-]+$/.test(lang)) {
    // Reserve the worker while the library downloads, so a second run
    // arriving meanwhile is refused rather than interleaved.
    var placeholder = { cancelled: false, interrupt: function () { this.cancelled = true; } };
    job = placeholder;
    jobId = id;
    var proceed = function (text) {
      if (job !== placeholder) return;   // reset meanwhile
      if (placeholder.cancelled) { finishRun(id, 'stopped', [{ kind: 'status', text: 'Stopped' }]); return; }
      if (text !== null) it.registerLibrary(lang, text);
      job = null;
      startRun(id, source);              // an unregistered name reports "Unknown #lang" itself
    };
    fetch('/core/lib/scheme/prelude/' + lang + '.scm').then(function (res) {
      return res.ok ? res.text() : null;
    }).then(proceed, function () { proceed(null); });
    return;
  }
  startRun(id, source);
}

onmessage = function (evt) {
  var msg = evt.data;
  switch (msg.op) {
    case 'init':
      try {
        ensureInterpreter();
        postMessage({ op: 'init', ok: true, buildId: SchemeEngine.buildId });
      } catch (e) {
        postMessage({ op: 'init', ok: false, error: String(e && e.message || e) });
      }
      break;
    case 'run':
      handleRun(msg.id, msg.source);
      break;
    case 'input':
      if (job && waitingInput && msg.id === jobId) {
        waitingInput = false;
        job.provideInput(msg.text);
        pump(job, jobId);
      }
      break;
    case 'interrupt':
      if (job) {
        job.interrupt();
        // A job parked on input is stepped once so it can observe the interrupt.
        if (waitingInput) { waitingInput = false; pump(job, jobId); }
      }
      break;
    case 'reset':
      job = null;
      jobId = null;
      waitingInput = false;
      interp = SchemeEngine.createInterpreter();
      postMessage({ op: 'reset', ok: true });
      break;
  }
};
