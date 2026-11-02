/**
 * lively.identity.PyodideWorker
 *
 * Client-side controller for the wiki's Python code-cell feature
 * (CodeEditorSpec.md §2.3). Owns one raw
 * `new Worker('/core/lib/pyodide/pyodide-worker.js')` per wiki page —
 * deliberately a plain singleton object, not an Object.subclass instance,
 * matching lively.jenga3d.Worker's own shape for the same reason (exactly
 * one worker/interpreter per page; every code_cell on that page shares it,
 * which is the owner-confirmed cell-isolation model — cells can see each
 * other's variables/imports, notebook-style).
 *
 * The Worker is created lazily on the first Run click anywhere on the page
 * (never on page load, never just because a page contains a code_cell) —
 * that's the entire "don't load ~24MB of Pyodide/numpy/matplotlib for a
 * reader who never runs anything" lazy-load gate; no separate doc-content
 * scan is needed on top of it.
 *
 * Unlike lively.jenga3d.Worker, requests are NOT superseded/queued by
 * nodeId — a code cell's Run button is disabled client-side while a run is
 * in flight (see WikiEditor._codeCellNodeView), so at most one `run` is
 * ever actually sent at a time in practice; this controller still queues
 * a second call defensively via a simple FIFO rather than assuming that.
 */

module('lively.identity.PyodideWorker')
  .requires()
  .toRun(function () {

    lively.identity.PyodideWorker = {

      RUN_TIMEOUT_MS: 30000,  // generous: cold numpy/matplotlib import + a first heavy computation can be slow

      _worker: null,
      _readyState: 'idle',    // 'idle' | 'loading' | 'ready' | 'failed'
      _readyCallbacks: [],
      _pending: {},           // id -> { thenDo, timer }
      _nextId: 1,
      _queue: [],             // FIFO of {source, thenDo} awaiting a free worker

      // lively.identity.PyodideWorker.ensureReady(thenDo)
      // thenDo(err) — err is null once the runtime + numpy/matplotlib are
      // loaded and ready to run cells.
      ensureReady: function (thenDo) {
        if (this._readyState === 'ready') return thenDo(null);
        if (this._readyState === 'failed') return thenDo(new Error('Pyodide failed to load earlier — reload the page to retry.'));
        this._readyCallbacks.push(thenDo);
        if (this._readyState === 'loading') return;
        this._readyState = 'loading';
        var self = this;
        this._ensureWorker().postMessage({ op: 'init' });
        this._initTimer = setTimeout(function () {
          if (self._readyState !== 'loading') return;
          self._onInitDone(new Error('Pyodide runtime timed out while loading.'));
        }, 60000);
      },

      _onInitDone: function (err) {
        if (this._initTimer) { clearTimeout(this._initTimer); this._initTimer = null; }
        this._readyState = err ? 'failed' : 'ready';
        var callbacks = this._readyCallbacks;
        this._readyCallbacks = [];
        callbacks.forEach(function (cb) { cb(err || null); });
      },

      // lively.identity.PyodideWorker.run(source, thenDo)
      // thenDo(err, response) where response = {stdout, stderr, result, images}
      // on success; on a Python-level error, err is an Error whose .message
      // is the formatted traceback, and response (still passed as the 2nd
      // arg-in-a-3rd-arg) carries stdout/stderr/images captured before the
      // failure. Call ensureReady() first — run() assumes the worker exists.
      run: function (source, thenDo) {
        var self = this;
        var id = this._nextId++;
        var timer = setTimeout(function () {
          self._onTimeout(id);
        }, this.RUN_TIMEOUT_MS);
        this._pending[id] = { thenDo: thenDo, timer: timer };
        this._ensureWorker().postMessage({ id: id, op: 'run', source: source });
      },

      // A real worker.terminate() — a synchronous WASM call can't be
      // cooperatively interrupted once started (same acknowledged
      // limitation as lively.jenga3d.Worker/occt-worker-src.js). Drops the
      // whole interpreter and any variables a shared session had built up;
      // the next run() call re-inits from scratch via _ensureWorker().
      terminate: function () {
        if (this._worker) { this._worker.terminate(); this._worker = null; }
        this._readyState = 'idle';
        var pending = this._pending;
        this._pending = {};
        Object.keys(pending).forEach(function (id) {
          clearTimeout(pending[id].timer);
          pending[id].thenDo(new Error('Cell stopped.'), null);
        });
      },

      _onTimeout: function (id) {
        var entry = this._pending[id];
        if (!entry) return;
        delete this._pending[id];
        this.terminate();
        entry.thenDo(new Error('Cell timed out after ' + Math.round(this.RUN_TIMEOUT_MS / 1000) + 's (stopped).'), null);
      },

      _ensureWorker: function () {
        if (this._worker) return this._worker;
        var self = this;
        this._worker = new Worker('/core/lib/pyodide/pyodide-worker.js');
        this._worker.onmessage = function (evt) { self._onMessage(evt.data); };
        this._worker.onerror = function (evt) {
          console.error('[lively.identity.PyodideWorker] worker error:', evt.message || evt);
        };
        return this._worker;
      },

      _onMessage: function (data) {
        if (data.op === 'init') {
          this._onInitDone(data.ok ? null : new Error(data.error));
          return;
        }
        var entry = this._pending[data.id];
        if (!entry) return;  // already timed out / terminated
        delete this._pending[data.id];
        clearTimeout(entry.timer);
        var response = { stdout: data.stdout || '', stderr: data.stderr || '', result: data.result, images: data.images || [] };
        entry.thenDo(data.ok ? null : new Error(data.error), response);
      },

    };

  });
