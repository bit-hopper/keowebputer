;;; Library selected by a cell's first line:  #lang eopl
;;;
;;; The vocabulary that interpreter-building code leans on:
;;;
;;;   define-datatype / cases      tagged variants with checked constructors
;;;   list-of, maybe, always?, empty
;;;   eopl:error, eopl:printf, eopl:pretty-print
;;;   sllgen:make-string-parser, sllgen:make-string-scanner, sllgen:make-stream-parser,
;;;   sllgen:make-define-datatypes, sllgen:list-define-datatypes,
;;;   sllgen:show-define-datatypes, sllgen:make-rep-loop
;;;
;;; Our own implementation. Its behaviour (message wording, what a constructor and
;;; `cases` check, how the scanner chooses tokens) was compared against the
;;; reference implementation of this language library, and the textbook's own interpreter
;;; sources were run against it; SchemeSpec.md section 20 lists what matches and
;;; what does not. The datatype registry and the scanner/parser engine are native
;;; (src/eopl.js); the names starting with % are its internal entry points. Keep
;;; any mutable state behind procedures: this file is compiled against the system
;;; globals, and top-level variables a library assigns later are not seen by user code.

;;; ---- predicate builders -----------------------------------------------------

(define (always? x) #t)

(define empty '())

;; (list-of pred ...): a proper list whose elements satisfy the predicates in turn,
;; starting over when the list is longer than the predicate list; the list's length
;; must be a whole number of rounds.
(define (list-of pred . more)
  (let ((preds (cons pred more)))
    (lambda (obj)
      (let loop ((l obj) (ps '()))
        (cond ((null? l) (null? ps))
              ((pair? l)
               (let ((ps (if (null? ps) preds ps)))
                 (and ((car ps) (car l))
                      (loop (cdr l) (cdr ps)))))
              (else #f))))))

(define (maybe pred)
  (lambda (obj) (or (pred obj) (eqv? obj #f))))

;;; ---- define-datatype / cases ------------------------------------------------

;; A constructor checks each field with its predicate. The predicates are not
;; evaluated when the type is declared but on every construction, so a field
;; may be checked by the predicate of a datatype defined further down.
;; make-VARIANT is also defined, as an alias of the constructor.
(define-syntax define-datatype
  (syntax-rules ()
    ((_ tname pred (vname (fname fpred) ...) ...)
     (begin
       (%define-datatype! 'tname '((vname fname ...) ...))
       (define pred (%datatype-predicate 'tname 'pred))
       (define vname
         (let ((dt (%find-datatype 'tname)))
           (named-lambda (vname fname ...)
             (%check-fields vname (fname fpred) ...)
             (%make-variant dt 'vname fname ...))))
       ...
       (%define-make-alias! 'vname vname)
       ...))))

(define-syntax %check-fields
  (syntax-rules ()
    ((_ vname) #t)
    ((_ vname (fname fpred) more ...)
     (if (fpred fname)
         (%check-fields vname more ...)
         (%bad-field 'vname 'fname fname)))))

;; (cases type expr (variant (field ...) body ...) ... [(else body ...)])
;; The expansion is done natively (%cases, in the compiler).
(define-syntax cases
  (syntax-rules ()
    ((_ . rest) (%cases . rest))))

;;; ---- errors, output ---------------------------------------------------------

;; (eopl:error 'who "format ~s" arg ...) reports  who: format ...
;; With a string first, as in (error "message" irritant ...), it is the plain error procedure.
(define (eopl:error who . rest)
  (if (symbol? who)
      (error (string-append (symbol->string who) ": " (%format-string (car rest) (cdr rest))))
      (apply error who rest)))

(define (eopl:printf fmt . args)
  (display (%format-string fmt args)))

(define eopl:pretty-print pp)

;;; ---- sllgen ---------------------------------------------------------------------

(define (sllgen:make-string-parser scanner grammar)
  (%sllgen-parser scanner grammar))

;; A procedure from a string to a list of tokens, each (class data line).
(define (sllgen:make-string-scanner scanner grammar)
  (%sllgen-scanner scanner grammar))

(define (sllgen:list-define-datatypes scanner grammar)
  (%sllgen-datatype-forms scanner grammar))

(define (sllgen:show-define-datatypes scanner grammar)
  (for-each pp (%sllgen-datatype-forms scanner grammar)))

;; Defines, in the page's global environment, the datatypes the grammar describes.
(define (sllgen:make-define-datatypes scanner grammar)
  (for-each (lambda (form) (eval form user-initial-environment))
            (%sllgen-datatype-forms scanner grammar)))

;; Here the "stream" parser works on the text of the lines the REPL loop reads: given a
;; string it returns (tree . rest-of-text), or #f when the text so far is not yet a
;; complete expression (an optional second argument, true, turns that into an error).
(define (sllgen:make-stream-parser scanner grammar)
  (%sllgen-stream-parser scanner grammar))

;; (sllgen:make-rep-loop "prompt> " eval-fn stream-parser) returns a thunk: show the
;; prompt, read and parse an expression (it may span lines, or several may share a
;; line), evaluate it, write the value and a newline, show the prompt again; ends
;; when the input does.
(define (sllgen:make-rep-loop prompt eval-fn stream-parser)
  (lambda ()
    (display prompt)
    (let loop ((buffer ""))
      (let ((r (stream-parser buffer)))
        (if r
            (begin
              (write (eval-fn (car r)))
              (newline)
              (display prompt)
              (loop (cdr r)))
            (let ((line (%read-line-string)))
              (if (eof-object? line)
                  (if (string=? (string-trim buffer) "")
                      #t
                      (stream-parser buffer #t))
                  (loop (string-append buffer "\n" line)))))))))
