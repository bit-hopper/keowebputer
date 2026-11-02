;;; Library selected by a cell's first line:  #lang sicp
;;;
;;; The few names the text uses without defining:
;;;   nil       the empty list
;;;   put / get the two-dimensional table behind data-directed dispatch:
;;;             (put op type item) stores, (get op type) returns the item or #f
;;;
;;; Streams, 1+, -1+, true, false, eval, the-environment and the rest of the
;;; MIT-flavoured names are already part of the core. Keep any mutable state
;;; behind procedures: this file is compiled against the system globals, and
;;; top-level variables a library assigns later are not seen by user code.

(define nil '())

(define sicp-table-operations
  (let ((table (make-equal-hash-table)))
    (cons (lambda (op type item)
            (hash-table-set! table (cons op type) item))
          (lambda (op type)
            (hash-table-ref/default table (cons op type) #f)))))

(define put (car sicp-table-operations))
(define get (cdr sicp-table-operations))
