;;; Library selected by a cell's first line:  #lang tls
;;;
;;; The small amount of dialect that book-style code assumes beyond the core:
;;;   atom?     the predicate such code defines for itself in its opening pages;
;;;             defining it again in a cell is harmless (the cell's definition wins)
;;;   letcc     bind the current continuation:  (letcc k body ...)
;;;   try       try one expression, fall back to the others if the named escape
;;;             is invoked:  (try escape primary fallback ...)
;;;
;;; add1 / sub1 and the usual list/number predicates are already primitives.
;;; Keep any mutable state behind procedures: this file is compiled against the
;;; system globals, and top-level variables a library assigns later are not seen
;;; by user code.

(define (atom? x)
  (and (not (pair? x)) (not (null? x))))

(define-syntax letcc
  (syntax-rules ()
    ((_ k body ...)
     (call-with-current-continuation (lambda (k) body ...)))))

(define-syntax try
  (syntax-rules ()
    ((_ escape primary fallback ...)
     (letcc success
       (letcc escape (success primary))
       fallback ...))))
