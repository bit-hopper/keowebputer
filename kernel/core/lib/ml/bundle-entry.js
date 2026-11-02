// Bundle entry for the browser/Worker build of the ML engine (see scripts/build-ml-lib.js). The engine itself lives in
// core/lib/ml/src and has no DOM / Worker globals; this file only attaches it to the global scope.
import { Interpreter, Job, MLError, showValue } from './src/index.js';

const root = typeof self !== 'undefined' ? self : globalThis;

root.MLEngine = {
  buildId: __ML_BUILD_ID__,
  Interpreter,
  Job,
  MLError,
  showValue,
  createInterpreter(opts = {}) {
    return new Interpreter(opts);
  },
};
