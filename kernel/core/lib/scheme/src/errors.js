// Constructors for the error conditions the engine raises. Each returns a
// SchemeThrow ready to `throw`. Report text (classic REPL style) is built in printer.js.
import { Condition, SchemeThrow } from './types.js';

export const ORDINALS = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth',
  'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

export function wrongType(obj, argIndex, procName) {
  return new SchemeThrow(new Condition('wrong-type', null, [obj], { argIndex, procName }));
}
export function badRange(obj, argIndex, procName) {
  return new SchemeThrow(new Condition('bad-range', null, [obj], { argIndex, procName }));
}
export function unboundVariable(name) {
  return new SchemeThrow(new Condition('unbound-variable', null, [], { name }));
}
export function unassignedVariable(name) {
  return new SchemeThrow(new Condition('unassigned-variable', null, [], { name }));
}
export function divByZero(procName) {
  return new SchemeThrow(new Condition('divide-by-zero', null, [], { procName }));
}
export function notApplicable(obj, args) {
  return new SchemeThrow(new Condition('inapplicable-object', null, [obj], { args }));
}
export function wrongArgs(proc, nargs) {
  return new SchemeThrow(new Condition('wrong-number-of-arguments', null, [proc], { nargs }));
}
// (error "message" irritant ...) -- message may be any Scheme value.
export function simpleError(message, irritants = []) {
  return new SchemeThrow(new Condition('simple-error', message, irritants));
}
// Convenience for engine-internal failures with a plain JS message.
export function schemeError(jsMessage, ...irritants) {
  return new SchemeThrow(new Condition('simple-error', jsMessage, irritants));
}
export function syntaxError(message, form) {
  return new SchemeThrow(new Condition('syntax-error', message, form === undefined ? [] : [form]));
}
export function parseError(message) {
  return new SchemeThrow(new Condition('parse-error', message, []));
}
