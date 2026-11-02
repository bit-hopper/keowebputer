module('lively.ide.tools.XtermCommandLineInterface').requires('lively.ide.CommandLineInterface').toRun(function() {

lively.ide.CommandLineInterface.PersistentCommand.subclass('lively.ide.tools.PtyCommand',
'control', {
    start: function(cols, rows) {
        // starts a real pty-backed shell on the server (core/servers/PtyServer.js)
        // and streams RAW (non-ANSI-stripped) output via the 'rawOutput' signal,
        // for an xterm.js instance to render itself.
        if (this._started) return this;
        this._started = true;
        this._startTime = Date.now();
        var self = this;
        this.send('startPtyCommand', {
            cwd: this._options.cwd, env: this._options.env,
            cols: cols || 80, rows: rows || 24
        }, function(err, answer) {
            if (err) { self.onEnd(1); return; }
            if (!answer) return;
            var data = answer.data;
            if (data && data.id) {
                self._ptyId = data.id;
                lively.bindings.signal(self, 'pid', data.pid);
                return;
            }
            if (!answer.expectMoreResponses) { self.onEnd(data && data.exitCode); return; }
            if (data && data.data != null) lively.bindings.signal(self, 'rawOutput', data.data);
        });
        return this;
    },

    write: function(string) {
        if (!this._ptyId) return;
        this.send('ptyInput', {id: this._ptyId, data: string}, function() {});
    },

    resize: function(cols, rows) {
        if (!this._ptyId) return;
        this.send('ptyResize', {id: this._ptyId, cols: cols, rows: rows}, function() {});
    },

    kill: function(signal, thenDo) {
        if (!this._ptyId) { thenDo && thenDo(); return; }
        this.send('stopPtyCommand', {id: this._ptyId, signal: signal || 'SIGHUP'}, function() { thenDo && thenDo(); });
    }
},
'accessing', {
    getPid: function() { return this._ptyId; }
});

});
