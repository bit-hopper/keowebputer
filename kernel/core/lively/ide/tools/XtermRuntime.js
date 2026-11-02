var xtermLoaded = false;

var xtermLibs = [{
  url: Config.codeBase + 'lib/xterm/xterm.js',
  loadTest: function() { return typeof Terminal !== 'undefined'; }
}, {
  url: Config.codeBase + 'lib/xterm/addon-fit.js',
  loadTest: function() { return !!Global.FitAddon; }
}];

(function loadXtermCss() {
  if (document.getElementById('xterm-css')) return;
  var link = document.createElement('link');
  link.id = 'xterm-css';
  link.rel = 'stylesheet';
  link.href = Config.codeBase + 'lib/xterm/xterm.css';
  document.getElementsByTagName('head')[0].appendChild(link);
})();

(function addXtermScrollbarStyle() {
  // scoped to .XtermTerminal so this never touches ace/world/other scrollbars
  if (document.getElementById('xterm-scrollbar-style')) return;
  var style = document.createElement('style');
  style.id = 'xterm-scrollbar-style';
  style.textContent =
    '.XtermTerminal .xterm-viewport {' +
    '  scrollbar-width: thin;' +
    '  scrollbar-color: rgba(255,255,255,0.22) transparent;' +
    '}' +
    '.XtermTerminal .xterm-viewport::-webkit-scrollbar {' +
    '  width: 10px;' +
    '}' +
    '.XtermTerminal .xterm-viewport::-webkit-scrollbar-button {' +
    '  display: none;' +
    '  height: 0;' +
    '  width: 0;' +
    '}' +
    '.XtermTerminal .xterm-viewport::-webkit-scrollbar-track {' +
    '  background: transparent;' +
    '}' +
    '.XtermTerminal .xterm-viewport::-webkit-scrollbar-thumb {' +
    '  background-color: rgba(255,255,255,0.18);' +
    '  border-radius: 8px;' +
    '  border: 2px solid transparent;' +
    '  background-clip: padding-box;' +
    '  min-height: 32px;' +
    '}' +
    '.XtermTerminal .xterm-viewport::-webkit-scrollbar-thumb:hover {' +
    '  background-color: rgba(255,255,255,0.32);' +
    '  background-clip: padding-box;' +
    '}' +
    '.XtermTerminal .xterm-viewport::-webkit-scrollbar-thumb:active {' +
    '  background-color: rgba(255,255,255,0.42);' +
    '  background-clip: padding-box;' +
    '}' +
    '.XtermTerminal .xterm-viewport::-webkit-scrollbar-corner {' +
    '  background: transparent;' +
    '}';
  document.getElementsByTagName('head')[0].appendChild(style);
})();

lively.lang.arr.mapAsyncSeries(xtermLibs,
  function(lib, _, n) { JSLoader.loadJs(lib.url); lively.lang.fun.waitFor(lib.loadTest, n); },
  function(err) { err && console.error(err); xtermLoaded = true; });

module('lively.ide.tools.XtermRuntime').requires().requiresLib({loadTest: function() { return !!xtermLoaded; }}).toRun(function() {
});
