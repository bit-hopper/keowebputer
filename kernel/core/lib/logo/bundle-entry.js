// Bundle entry for the browser/Worker build of the Logo engine (see scripts/build-logo-lib.js; lives here rather than in
// build/, which is gitignored). The engine itself lives in core/lib/logo/src and has no DOM / Worker globals; this file
// only attaches it to the global scope and inlines the always-loaded prelude.
import { Interpreter, Job, LogoError, formatNumber, showText, printText, renderSegments } from './src/index.js';
import corePrelude from './prelude/core.logo';

const root = typeof self !== 'undefined' ? self : globalThis;

root.LogoEngine = {
  buildId: __LOGO_BUILD_ID__,
  Interpreter,
  Job,
  LogoError,
  formatNumber,
  showText,
  printText,
  renderSegments,
  corePrelude,
  createInterpreter(opts = {}) {
    return new Interpreter({ prelude: corePrelude, ...opts });
  },
};
