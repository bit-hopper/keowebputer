// Bundle entry for the browser/Worker build of the Scheme engine
// (see scripts/build-scheme-lib.js; lives here rather than in build/, which is gitignored). The engine itself lives in
// core/lib/scheme/src and has no DOM / Worker globals; this file only attaches
// it to the global scope and inlines the always-loaded prelude.
import { Interpreter, Job, Parser, transcript, setMaxDepth, printSettings } from './src/index.js';
import corePrelude from './prelude/core.scm';

const root = typeof self !== 'undefined' ? self : globalThis;

root.SchemeEngine = {
  buildId: __SCHEME_BUILD_ID__,
  Interpreter,
  Job,
  Parser,
  transcript,
  setMaxDepth,
  printSettings,
  corePrelude,
  // libraries: { name: sourceText } for `#lang name` (fetched by the worker on demand)
  createInterpreter(opts = {}) {
    return new Interpreter({ prelude: corePrelude, ...opts });
  },
};
