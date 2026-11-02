/**
 * lively.identity.CodeCellWorker
 *
 * The one implementation of the client-side controller for the wiki's transcript code cells (Scheme, ML, Logo and TPN:
 * every registry row whose `output` is 'transcript'). lively.identity.SchemeWorker, MLWorker and LogoWorker are each
 * `CodeCellWorker.create({...})` and nothing else; they used to be three copies that differed only in a name and a worker
 * URL (LOGO.md Q9). Python is not served by this: its controller (PyodideWorker) is a different shape.
 *
 * A controller owns one raw `new Worker(workerUrl)` per wiki page, created lazily on the first Run click (never on page
 * load). Same plain singleton shape as lively.identity.PyodideWorker: every cell of the language on the page shares the
 * one interpreter, notebook-style. The worker's protocol is documented in each worker file (core/lib/<lang>/<lang>-worker.js);
 * the controller passes through the messages it knows:
 *   segments   -> handlers.onSegments(segments)
 *   draw       -> handlers.onDraw(ops, turtle)          (graphics languages: Logo)
 *   needInput  -> handlers.onNeedInput()                (languages that read input: Scheme)
 *   done       -> handlers.onDone(err, {state})
 * A message type a language never sends is simply never delivered, so one controller serves all of them.
 *
 * Differences from the Python controller:
 *  - Output streams: a run reports ordered segments {kind, text} as they are produced.
 *  - Stop is two-tier. interrupt() asks the interpreter to stop at its next time-slice boundary, so the global environment
 *    survives. Only if no answer arrives within STOP_GRACE_MS (a runaway native primitive) is the worker terminated, which
 *    loses the environment.
 *  - No wall-clock run timeout; Stop is the escape hatch.
 *  - One run at a time per page; a second run() while one is active is refused with an error rather than queued behind a
 *    possibly endless one.
 *
 * Do not add language-specific behaviour here: pass an option, or put it in the language's own controller file.
 */

module('lively.identity.CodeCellWorker')
  .requires()
  .toRun(function () {

    lively.identity.CodeCellWorker = {

      // opts: {
      //   name       the language's name as shown in messages ('Scheme', 'ML', 'Logo')
      //   workerUrl  the Worker script ('/core/lib/scheme/scheme-worker.js')
      //   path       the controller's own dotted path, for the console error ('lively.identity.SchemeWorker')
      //   sendLanguage  optional; true for a worker that serves more than one registry row (Logo: `logo` and `tpn`), so the
      //              run message carries the cell's language id. Off by default: Scheme and ML send exactly what they did.
      // }
      // Returns the controller object, which the caller assigns to its own global.
      create: function (opts) {
        var name = opts.name;

        return {

          STOP_GRACE_MS: 3000,

          _worker: null,
          _readyState: 'idle',    // 'idle' | 'loading' | 'ready' | 'failed'
          _readyCallbacks: [],
          _active: null,          // { id, handlers, stopTimer } for the run in flight
          _resetCallbacks: [],
          _nextId: 1,
          buildId: null,

          // thenDo(err) once the engine is loaded in the worker.
          ensureReady: function (thenDo) {
            if (this._readyState === 'ready') return thenDo(null);
            if (this._readyState === 'failed') return thenDo(new Error('The ' + name + ' engine failed to load earlier — reload the page to retry.'));
            this._readyCallbacks.push(thenDo);
            if (this._readyState === 'loading') return;
            this._readyState = 'loading';
            var self = this;
            this._ensureWorker().postMessage({ op: 'init' });
            this._initTimer = setTimeout(function () {
              if (self._readyState !== 'loading') return;
              self._onInitDone(new Error('The ' + name + ' engine timed out while loading.'));
            }, 20000);
          },

          _onInitDone: function (err) {
            if (this._initTimer) { clearTimeout(this._initTimer); this._initTimer = null; }
            this._readyState = err ? 'failed' : 'ready';
            var callbacks = this._readyCallbacks;
            this._readyCallbacks = [];
            callbacks.forEach(function (cb) { cb(err || null); });
          },

          // handlers: {
          //   onSegments(segments)   new output, in order; kinds: stdout | value | warning | error | status (which of them a
          //                          language produces is its own business)
          //   onDraw(ops, turtle)    graphics languages: the drawing since the last call, as the engine's draw operations
          //                          (see core/lib/logo/src/turtle.js), and the turtle's state when it changed (else null).
          //                          Always delivered before the same slice's onSegments.
          //   onNeedInput()          the cell asked for a line; answer with provideInput(text)
          //   onDone(err, result)    result = {state: done | error | stopped | exit}; err only for
          //                          failures of the run machinery itself (worker lost, busy, ...)
          // }
          // runOpts: {language}   the cell's registry id; sent to the worker only when the controller was created with
          //                       sendLanguage (see create)
          // Call ensureReady() first.
          run: function (source, handlers, runOpts) {
            handlers = handlers || {};
            if (this._active) {
              if (handlers.onDone) handlers.onDone(new Error('Another ' + name + ' cell is still running on this page. Stop it first.'), null);
              return;
            }
            var id = this._nextId++;
            this._active = { id: id, handlers: handlers, stopTimer: null };
            var msg = { id: id, op: 'run', source: source };
            if (opts.sendLanguage && runOpts && runOpts.language) msg.language = runOpts.language;
            this._ensureWorker().postMessage(msg);
          },

          isRunning: function () { return !!this._active; },

          // Answers a pending onNeedInput. text === null means end of input.
          provideInput: function (text) {
            if (!this._active || !this._worker) return;
            this._worker.postMessage({ op: 'input', id: this._active.id, text: text });
          },

          // Tier 1: cooperative interrupt, environment survives. Tier 2 (no
          // answer within STOP_GRACE_MS): kill the worker, environment lost.
          // The active run's onDone always fires afterwards.
          interrupt: function () {
            var active = this._active;
            if (!active || !this._worker) return;
            this._worker.postMessage({ op: 'interrupt' });
            if (active.stopTimer) return;
            var self = this;
            active.stopTimer = setTimeout(function () {
              if (self._active !== active) return;
              self.terminate('The cell did not respond to Stop, so the ' + name + ' runtime was restarted — definitions from earlier cells are gone.');
            }, this.STOP_GRACE_MS);
          },

          // Fresh interpreter (core library only). The worker stays alive. thenDo(err).
          reset: function (thenDo) {
            thenDo = thenDo || function () {};
            if (!this._worker || this._readyState !== 'ready') { return thenDo(null); }  // nothing to reset yet
            var active = this._active;
            if (active) this._finishActive(null, { state: 'stopped' });
            this._resetCallbacks.push(thenDo);
            this._worker.postMessage({ op: 'reset' });
          },

          // A real worker.terminate(): drops the interpreter and all definitions.
          // The next ensureReady()/run() creates a fresh worker.
          terminate: function (reason) {
            if (this._worker) { this._worker.terminate(); this._worker = null; }
            this._readyState = 'idle';
            if (this._initTimer) { clearTimeout(this._initTimer); this._initTimer = null; }
            var resets = this._resetCallbacks;
            this._resetCallbacks = [];
            resets.forEach(function (cb) { cb(null); });
            var waiting = this._readyCallbacks;
            this._readyCallbacks = [];
            waiting.forEach(function (cb) { cb(new Error('Cell stopped.')); });
            if (this._active) this._finishActive(new Error(reason || 'Cell stopped.'), null);
          },

          _finishActive: function (err, result) {
            var active = this._active;
            if (!active) return;
            this._active = null;
            if (active.stopTimer) clearTimeout(active.stopTimer);
            if (active.handlers.onDone) active.handlers.onDone(err, result);
          },

          _ensureWorker: function () {
            if (this._worker) return this._worker;
            var self = this;
            var worker = new Worker(opts.workerUrl);
            this._worker = worker;
            worker.onmessage = function (evt) { if (self._worker === worker) self._onMessage(evt.data); };
            worker.onerror = function (evt) {
              console.error('[' + opts.path + '] worker error:', evt.message || evt);
              if (self._worker !== worker) return;
              if (self._readyState === 'loading') self._onInitDone(new Error('The ' + name + ' engine failed to load.'));
            };
            return worker;
          },

          _onMessage: function (data) {
            if (data.op === 'init') {
              if (data.ok) this.buildId = data.buildId;
              this._onInitDone(data.ok ? null : new Error(data.error));
              return;
            }
            if (data.op === 'reset') {
              var resets = this._resetCallbacks;
              this._resetCallbacks = [];
              resets.forEach(function (cb) { cb(null); });
              return;
            }
            var active = this._active;
            if (!active || data.id !== active.id) return;   // stale: stopped / reset / terminated
            var handlers = active.handlers;
            if (data.op === 'segments') {
              if (handlers.onSegments) handlers.onSegments(data.segments);
            } else if (data.op === 'draw') {
              if (handlers.onDraw) handlers.onDraw(data.ops, data.turtle);
            } else if (data.op === 'needInput') {
              if (handlers.onNeedInput) handlers.onNeedInput();
              else this.provideInput(null);
            } else if (data.op === 'done') {
              if (data.segments && data.segments.length && handlers.onSegments) handlers.onSegments(data.segments);
              this._finishActive(null, { state: data.state });
            }
          },

        };
      },

    };

  });
