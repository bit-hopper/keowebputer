module('lively.ide.tools.XtermTerminal').requires(
    'lively.morphic', 'lively.persistence.BuildSpec',
    'lively.ide.tools.XtermRuntime', 'lively.ide.tools.XtermCommandLineInterface').toRun(function() {

// Verified live (2026-08-12) via Chrome DevTools MCP click+type_text on the
// real focused textarea: an xterm.js instance nested inside a morph's own
// shapeNode (via lively.morphic.Shapes.External) DOES receive real keystrokes
// here, unlike the native-input-in-shapeNode failure documented in CLAUDE.md
// for plain <input>/<textarea> dialogs. No document.body-sync fallback needed.
lively.morphic.Shapes.External.subclass('lively.ide.tools.XtermShape',
'initializing', {
    initialize: function($super) { $super(document.createElement('div')); }
},
'HTML rendering', {
    // this.extent (not the DOM node's clientWidth/clientHeight) is the single
    // source of truth. Reading size back off the DOM here created a feedback
    // loop with StyleSheetsHTML.js's setBorderWidthHTML, which re-reads
    // getExtent() and re-applies it via setExtentHTML on every border-related
    // call (including ones that happen before the DOM has caught up to a
    // just-applied size) -- that stomped a correctly-applied extent back to
    // (0,0) after the fact. Confirmed live by instrumenting setExtentHTML.
    getExtentHTML: function($super, ctx) {
        return this.extent || $super(ctx);
    },
    setExtentHTML: function(ctx, value) {
        this.extent = value;
        if (!ctx.shapeNode) return value;
        ctx.domInterface.setExtent(ctx.shapeNode, value);
        if (this.onResized) this.onResized(value);
        return value;
    }
});

lively.morphic.Morph.subclass('lively.ide.tools.XtermTerminal',
'initializing', {
    // lively.persistence.BuildSpec#createMorph always overwrites instance.shape
    // with instance.defaultShape() right after construction (discarding whatever
    // shape initialize() set here), then calls onFromBuildSpecCreated() once the
    // whole morph tree is assembled -- same pattern lively.ide.CodeEditor uses
    // for its CodeEditorShape. So shape setup goes through defaultShape(), and
    // the onResized hookup + whenOpenedInWorld trigger must be (re-)done in
    // onFromBuildSpecCreated, not just in initialize (which only covers morphs
    // created via plain `new`, not ones built from a BuildSpec).
    initialize: function($super, bounds) {
        $super(this.defaultShape());
        if (bounds && bounds.isRectangle) this.setBounds(bounds);
        this._wireShapeAndSetup();
    },
    defaultShape: function() {
        return new lively.ide.tools.XtermShape();
    },
    onFromBuildSpecCreated: function($super) {
        $super();
        this._wireShapeAndSetup();
    },
    _wireShapeAndSetup: function() {
        var self = this;
        this.getShape().onResized = function() { self._fit(); };
        this.whenOpenedInWorld(function() { self._setup(); });
    }
},
'terminal setup', {
    _setup: function() {
        if (this._term) return;
        var self = this, node = this.getShape().shapeNode;
        node.style.background = 'black';
        // re-apply the size that was cached (but not yet DOM-applied) by
        // setExtentHTML before shapeNode existed
        var shape = this.getShape();
        if (shape.extent) this.setExtent(shape.extent);

        this._term = new Terminal({cursorBlink: true, fontSize: 12, theme: lively.ide.tools.XtermTerminal.THEME});
        this._fitAddon = new FitAddon.FitAddon();
        this._term.loadAddon(this._fitAddon);
        this._term.open(node);

        this._cmd = new lively.ide.tools.PtyCommand('', {cwd: lively.shell.cwd()});
        lively.bindings.connect(this._cmd, 'rawOutput', this._term, 'write', {});
        this._term.onData(function(data) { self._cmd.write(data); });

        this._fit();
        this._cmd.start(this._term.cols, this._term.rows);
    },
    _fit: function() {
        if (!this._fitAddon || !this._term) return;
        try { this._fitAddon.fit(); } catch (e) { return; }
        if (this._cmd) this._cmd.resize(this._term.cols, this._term.rows);
    },
    focus: function($super) {
        $super();
        if (this._term) this._term.focus();
    }
},
'cleanup', {
    onRemove: function($super) {
        if (this._cmd) this._cmd.kill();
        if (this._term) this._term.dispose();
        $super();
    }
});

// xterm.js's built-in default theme pairs blue (#2472c8) too close in contrast
// to green (#0dbc79) -- on /mnt/c (WSL DrvFs) paths, `ls` marks nearly every
// directory "other-writable" (LS_COLORS ow=34;42, tw=30;42: blue/black text on
// a green background), so that specific pairing shows up constantly and reads
// as nearly illegible. Confirmed live (2026-08-13) via `echo $LS_COLORS`.
// A first attempt (blue #5ec4ff / green #4caf50) still failed: both colors had
// near-identical WCAG relative luminance (0.49 vs 0.33, ~1.4:1 contrast) despite
// looking like different hues -- luminance, not hue distance, is what makes text
// legible against a fill. Green here is deliberately darkened (~0.12 luminance)
// and blue lightened (~0.60 luminance) to get blue-on-green to ~3.9:1; this
// necessarily trades away some of the (rare -- sticky+world-writable only)
// black-on-green legibility, ~2.8:1, since no foreground color can hit 3:1
// against a green as bright as xterm's original default.
lively.ide.tools.XtermTerminal.THEME = {
    background: '#000000',
    foreground: '#e6e6e6',
    cursor: '#e6e6e6',
    cursorAccent: '#000000',
    selectionBackground: 'rgba(97,175,239,0.35)',
    black: '#1a1a1a',
    red: '#f2777a',
    green: '#1e6b30',
    yellow: '#e5c07b',
    blue: '#9ad6ff',
    magenta: '#c792ea',
    cyan: '#56b6c2',
    white: '#d4d4d4',
    brightBlack: '#6b6b6b',
    brightRed: '#ff6b6b',
    brightGreen: '#7fd88f',
    brightYellow: '#f2d675',
    brightBlue: '#82cfff',
    brightMagenta: '#dba9f0',
    brightCyan: '#7fdce0',
    brightWhite: '#ffffff'
};

lively.BuildSpec('lively.ide.tools.XtermTerminalWindow', {
    _BorderColor: Color.rgb(204,0,0),
    _Extent: lively.pt(735.0,430.0),
    className: "lively.morphic.Window",
    sourceModule: "lively.morphic.Widgets",
    contentOffset: lively.pt(4.0,22.0),
    draggingEnabled: true,
    layout: {
        adjustForNewBounds: true
    },
    name: "XtermTerminal",
    submorphs: [{
        _Position: lively.pt(4.0,22.0),
        _Extent: lively.pt(727.0,404.0),
        className: "lively.ide.tools.XtermTerminal",
        name: "Terminal",
        layout: {
            resizeWidth: true,
            resizeHeight: true
        }
    }],
    titleBar: "Terminal (xterm)",
    onWindowGetsFocus: function onWindowGetsFocus() {
        this.get('Terminal').focus();
    }
});

});
