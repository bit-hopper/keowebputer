;;; Library selected by a cell's first line:  #lang simply
;;;
;;; The word-and-sentence vocabulary that introductory courses build on,
;;; following the behaviour the course textbook documents (its chapters and the
;;; appendix listing of the course library), written fresh here rather than copied.
;;; A WORD is a symbol, string or number; a SENTENCE is a list of words.
;;;
;;;   word? sentence? empty?  first last butfirst bf butlast bl item count
;;;   word sentence se  member? before? appearances  every keep accumulate
;;;   reduce repeated  show show-line align  read-line read-string
;;;   match  trace untrace  make-node datum children
;;;   string->word word->string char->word
;;;
;;; Where this deliberately differs from the book's course library:
;;;  - The engine is case-sensitive, so capital letters can start and continue a
;;;    symbol (the original keeps text with capitals as strings, because the
;;;    Scheme it ran on folded case).
;;;  - The original also rewires the whole interpreter. Arithmetic, comparisons and
;;;    indexes accepting text such as "05" is kept, but natively: it is switched on
;;;    (page-wide, until Reset) at the end of this file and only ever turns what
;;;    would have been an error into a result. The rest (a looser equal?, number?
;;;    and integer? answering for text, an always-exact round, its own random) would
;;;    change what other cells compute, so it is not applied. Inside this library
;;;    the loose word comparison is a private helper (used by member?, appearances
;;;    and match).
;;;  - No file-port procedures (there are no files in a browser cell).
;;;  - align never prints a stray leading 0 for a fraction that rounds to 0 digits.
;;;  - Capital-letter error names (FIRST, ITEM, ...) and message wording follow the
;;;    book; the text after the colon is the offending value, as the engine prints it.
;;;
;;; This replaces the core's list-oriented first / last / count / every / reduce
;;; and the core's trace / untrace for the rest of the page (Reset restores them).
;;; The core's own procedures don't call them. reduce still accepts the core's
;;; three-argument form. Keep any mutable state behind procedures: this file is
;;; compiled against the system globals, and top-level variables a library assigns
;;; later are not seen by user code.

;;; ---------------------------------------------------------------- captured core procedures

(define %core-reduce reduce)
(define %primitive-read-line %read-line-string)

;;; ---------------------------------------------------------------- characters and words
;;; (names start with % so they stay out of the way of user definitions)

;; 0 letter or symbol-initial character, 1 + - ., 2 digit, 3 anything else
(define (%char-rank c)
  (cond ((or (and (char>=? c #\a) (char<=? c #\z))
             (and (char>=? c #\A) (char<=? c #\Z))
             (memv c '(#\! #\$ #\% #\& #\* #\/ #\: #\< #\= #\> #\? #\~ #\_ #\^)))
         0)
        ((memv c '(#\+ #\- #\.)) 1)
        ((and (char>=? c #\0) (char<=? c #\9)) 2)
        (else 3)))

;; digits, with at most one point, from index i; "23.0" is accepted, other
;; decimals may not end in 0
(define (%digits-tail? s i len seen-point?)
  (cond ((= i len)
         (if seen-point? (not (char=? (string-ref s (- len 1)) #\0)) #t))
        ((char=? (string-ref s i) #\.)
         (cond (seen-point? #f)
               ((= (+ i 2) len) #t)
               (else (%digits-tail? s (+ i 1) len #t))))
        ((= (%char-rank (string-ref s i)) 2) (%digits-tail? s (+ i 1) len seen-point?))
        (else #f)))

;; text that is written the way a number normally is: no leading zero ("03"),
;; no leading point (".5"), no trailing zero in a decimal ("1.50"), no "-0"
(define (%narrow-number? s)
  (let ((len (string-length s)))
    (and (> len 0)
         (let* ((negative? (and (char=? (string-ref s 0) #\-) (not (= len 1))))
                (start (if negative? 1 0))
                (c0 (string-ref s start))
                (cn (string-ref s (- len 1))))
           (cond ((not (= (%char-rank cn) 2)) #f)
                 ((char=? c0 #\.) #f)
                 ((char=? c0 #\0)
                  (cond ((= len 1) #t)
                        ((= len 2) #f)
                        ((char=? (string-ref s (+ start 1)) #\.)
                         (%digits-tail? s (+ start 2) len #t))
                        (else #f)))
                 (else (%digits-tail? s start len #f)))))))

;; text that reads as a plain symbol: starts with a letter or one of ! $ % & * / : < = > ? ~ _ ^
;; and continues with those, letters, digits, + - .   (or is "+", "-", "...")
(define (%ok-symbol? s)
  (let ((len (string-length s)))
    (and (> len 0)
         (let ((rank (%char-rank (string-ref s 0))))
           (cond ((= rank 0)
                  (let loop ((i 1))
                    (or (= i len)
                        (and (<= (%char-rank (string-ref s i)) 2) (loop (+ i 1))))))
                 ((= rank 1) (and (member s '("+" "-" "...")) #t))
                 (else #f))))))

;; the word whose text is s: a number if it is written like one, else a symbol
;; if it reads as one, else the string itself
(define (string->word s)
  (cond ((%narrow-number? s) (string->number s))
        ((%ok-symbol? s) (string->symbol s))
        (else s)))

(define (char->word c)
  (let ((rank (%char-rank c)) (s (string c)))
    (cond ((= rank 0) (string->symbol s))
          ((= rank 2) (string->number s))
          ((char=? c #\+) '+)
          ((char=? c #\-) '-)
          (else s))))

(define (word->string w)
  (cond ((string? w) w)
        ((number? w) (number->string w))
        (else (symbol->string w))))

;; the letters of a word, each as a word
(define (%word-chars w)
  (map char->word (string->list (word->string w))))

(define (%bad who x)
  (error (string-append "Invalid argument to " who ":") x))

;; equality of words as the book's library sees it: 3 and "3", abc and "abc"
(define (%same? x y)
  (cond ((equal? x y) #t)
        ((and (pair? x) (pair? y)) (and (%same? (car x) (car y)) (%same? (cdr x) (cdr y))))
        ((and (number? x) (number? y)) (= x y))
        ((and (symbol? x) (string? y)) (string=? (symbol->string x) y))
        ((and (string? x) (symbol? y)) (string=? x (symbol->string y)))
        ((and (number? x) (string? y)) (let ((w (string->word y))) (and (number? w) (= x w))))
        ((and (string? x) (number? y)) (let ((w (string->word x))) (and (number? w) (= w y))))
        (else #f)))

;;; ---------------------------------------------------------------- predicates

(define (word? x)
  (or (symbol? x) (string? x) (number? x)))

(define (sentence? x)
  (and (list? x) (let loop ((l x)) (or (null? l) (and (word? (car l)) (loop (cdr l)))))))

(define (empty? x)
  (or (null? x) (and (string? x) (= (string-length x) 0))))

;;; ---------------------------------------------------------------- selectors

(define (first x)
  (cond ((pair? x) (car x))
        ((empty? x) (%bad "FIRST" x))
        ((word? x) (char->word (string-ref (word->string x) 0)))
        (else (%bad "FIRST" x))))

(define (last x)
  (cond ((pair? x) (let loop ((l x)) (if (null? (cdr l)) (car l) (loop (cdr l)))))
        ((empty? x) (%bad "LAST" x))
        ((word? x)
         (let ((s (word->string x)))
           (char->word (string-ref s (- (string-length s) 1)))))
        (else (%bad "LAST" x))))

(define (butfirst x)
  (cond ((pair? x) (cdr x))
        ((empty? x) (%bad "BUTFIRST" x))
        ((word? x)
         (let ((s (word->string x))) (string->word (substring s 1 (string-length s)))))
        (else (%bad "BUTFIRST" x))))

(define (butlast x)
  (cond ((pair? x) (list-head x (- (length x) 1)))
        ((empty? x) (%bad "BUTLAST" x))
        ((word? x)
         (let ((s (word->string x))) (string->word (substring s 0 (- (string-length s) 1)))))
        (else (%bad "BUTLAST" x))))

(define bf butfirst)
(define bl butlast)

(define (count x)
  (cond ((word? x) (string-length (word->string x)))
        ((list? x) (length x))
        (else (%bad "COUNT" x))))

(define (item index stuff)
  (define n (if (string? index) (or (string->number index) index) index))
  (cond ((not (integer? n))
         (error "Invalid first argument to ITEM (must be an integer):" n))
        ((< n 1)
         (error "Invalid first argument to ITEM (must be positive):" n))
        ((> n (count stuff)) (error "No such item:" n stuff))
        ((word? stuff) (char->word (string-ref (word->string stuff) (- n 1))))
        (else (list-ref stuff (- n 1)))))

;;; ---------------------------------------------------------------- constructors

(define (word . args)
  (string->word
   (apply string-append
          (map (lambda (a)
                 (if (word? a)
                     (word->string a)
                     (error "Invalid argument to WORD:" a)))
               args))))

(define (%sentence-append a original b)
  (cond ((null? a) b)
        ((word? (car a)) (cons (car a) (%sentence-append (cdr a) original b)))
        (else (error "Argument to SENTENCE not a word or sentence:" original))))

(define (%sentence-combine a b)
  (cond ((pair? a) (%sentence-append a a b))
        ((null? a) b)
        ((word? a) (cons a b))
        (else (error "Argument to SENTENCE not a word or sentence:" a))))

(define (sentence . args)
  (let loop ((args args))
    (if (null? args)
        '()
        (%sentence-combine (car args) (loop (cdr args))))))

(define se sentence)

;;; ---------------------------------------------------------------- comparisons

(define (member? x stuff)
  (cond ((empty? stuff) #f)
        ((word? stuff)
         (if (not (word? x))
             (error "Invalid arguments to MEMBER?:" x stuff)
             (let ((small (word->string x)) (big (word->string stuff)))
               (cond ((> (string-length small) 1) (error "Invalid arguments to MEMBER?:" x stuff))
                     ((= (string-length small) 0) #f)
                     (else
                      (let loop ((i 0))
                        (cond ((= i (string-length big)) #f)
                              ((char=? (string-ref small 0) (string-ref big i)) #t)
                              (else (loop (+ i 1))))))))))
        ((not (list? stuff)) (error "Invalid second argument to MEMBER?:" stuff))
        ((word? x)
         (let loop ((l stuff))
           (cond ((null? l) #f)
                 ((%same? x (car l)) #t)
                 (else (loop (cdr l))))))
        (else (error "Invalid first argument to MEMBER?:" x))))

;; alphabetical order of the words' text (so 10 comes before 9)
(define (before? a b)
  (cond ((not (word? a)) (error "Invalid first argument to BEFORE? (not a word):" a))
        ((not (word? b)) (error "Invalid second argument to BEFORE? (not a word):" b))
        (else (string<? (word->string a) (word->string b)))))

(define (appearances x stuff)
  (count (keep (lambda (element) (%same? x element)) stuff)))

;;; ---------------------------------------------------------------- higher-order

;; The words of a sentence satisfying pred, as a sentence; the letters of a word
;; satisfying pred, as a word.
(define (keep pred stuff)
  (cond ((not (procedure? pred))
         (error "Invalid first argument to KEEP (not a procedure):" pred))
        ((pair? stuff) (filter pred stuff))
        ((word? stuff)
         (string->word
          (list->string
           (filter (lambda (c) (pred (char->word c)))
                   (string->list (word->string stuff))))))
        ((null? stuff) '())
        (else (error "Bad second argument to KEEP (not a word or sentence):" stuff))))

(define (%every-list fn l)
  (if (null? l)
      '()
      (sentence (fn (car l)) (%every-list fn (cdr l)))))

;; Apply fn to each word of a sentence (each letter of a word); the results are
;; combined into one sentence.
(define (every fn stuff)
  (cond ((not (procedure? fn))
         (error "Invalid first argument to EVERY (not a procedure):" fn))
        ((word? stuff) (%every-list fn (%word-chars stuff)))
        ((list? stuff) (%every-list fn stuff))
        (else (error "Invalid second argument to EVERY:" stuff))))

;; Combine the words (letters) with a two-argument procedure, from the right.
(define (accumulate combiner stuff)
  (cond ((not (procedure? combiner))
         (error "Invalid first argument to ACCUMULATE (not a procedure):" combiner))
        ((not (or (word? stuff) (list? stuff)))
         (error "Invalid second argument to ACCUMULATE:" stuff))
        (else
         (let ((l (if (word? stuff) (%word-chars stuff) stuff)))
           (cond ((not (null? l))
                  (let loop ((l l))
                    (if (null? (cdr l))
                        (car l)
                        (combiner (car l) (loop (cdr l))))))
                 ((memq combiner (list + * word sentence)) (combiner))
                 (else (error "Can't accumulate empty input with that combiner")))))))

;; (reduce combiner list): like accumulate on a list. With three arguments it is
;; the core's (reduce combiner initial list).
(define (reduce combiner . rest)
  (cond ((= (length rest) 2) (apply %core-reduce combiner rest))
        ((not (= (length rest) 1)) (error "reduce takes 2 or 3 arguments"))
        ((not (procedure? combiner))
         (error "Invalid first argument to REDUCE (not a procedure):" combiner))
        ((not (list? (car rest)))
         (error "Invalid second argument to REDUCE (not a list):" (car rest)))
        ((not (null? (car rest)))
         (let loop ((l (car rest)))
           (if (null? (cdr l))
               (car l)
               (combiner (car l) (loop (cdr l))))))
        ((memq combiner (list + * word sentence append)) (combiner))
        (else (error "Can't reduce empty input with that combiner"))))

;; (repeated f n) is the procedure that applies f n times.
(define (repeated f n)
  (lambda (x)
    (let loop ((i n) (x x))
      (if (<= i 0) x (loop (- i 1) (f x))))))

;;; ---------------------------------------------------------------- trees

(define make-node cons)
(define datum car)
(define children cdr)

;;; ---------------------------------------------------------------- output

;; Print the argument (as display does) and start a new line.
(define (show x . port)
  (apply display x port)
  (apply newline port))

;; Print the words of a sentence separated by spaces, without the parentheses.
(define (show-line line . args)
  (cond ((>= (length args) 2) (error "Too many arguments to show-line"))
        ((not (list? line)) (error "Invalid argument to SHOW-LINE (not a list):" line))
        (else
         (let ((port (if (null? args) (current-output-port) (car args))))
           (if (pair? line)
               (begin
                 (display (car line) port)
                 (for-each (lambda (w) (display " " port) (display w port)) (cdr line))))
           (newline port)))))

;; (align value width [digits]): a string exactly width characters long. A number
;; is right-justified and rounded to digits places after the point (default 0);
;; anything else is left-justified. When it doesn't fit, the first width-1
;; characters are kept and a + shows that something is missing.
(define (align obj width . rest)
  (define (fit s number?)
    (let ((n (string-length s)))
      (cond ((= n width) s)
            ((< n width)
             (if number?
                 (string-append (make-string (- width n) #\space) s)
                 (string-append s (make-string (- width n) #\space))))
            (else (string-append (substring s 0 (max 0 (- width 1))) "+")))))
  (define (number-text)
    (let* ((places (if (null? rest) 0 (car rest)))
           (big (exact (round (* (abs obj) (expt 10 places)))))
           (raw (number->string big))
           (digits (if (<= (string-length raw) places)
                       (string-append (make-string (- (+ places 1) (string-length raw)) #\0) raw)
                       raw))
           (n (string-length digits))
           (body (if (= places 0)
                     digits
                     (string-append (substring digits 0 (- n places)) "."
                                    (substring digits (- n places) n)))))
      (if (< obj 0) (string-append "-" body) body)))
  (cond ((number? obj) (fit (number-text) #t))
        ((word? obj) (fit (word->string obj) #f))
        (else (%bad "ALIGN" obj))))

;;; ---------------------------------------------------------------- input

;; one line of console input (or of a port) as a string; end of input is the eof object
(define (read-string . port)
  (apply %primitive-read-line port))

;; one line of console input (or of a port) as a sentence; an empty line is ()
(define (read-line . port)
  (let ((line (apply %primitive-read-line port)))
    (if (eof-object? line)
        line
        (let loop ((chars (string->list line)) (current '()) (words '()))
          (define (flush)
            (if (null? current)
                words
                (cons (string->word (list->string (reverse current))) words)))
          (cond ((null? chars) (reverse (flush)))
                ((char-whitespace? (car chars)) (loop (cdr chars) '() (flush)))
                (else (loop (cdr chars) (cons (car chars) current) words)))))))

;;; ---------------------------------------------------------------- pattern matcher
;;;
;;; (match pattern sentence) -> the word  failed  when it fails; otherwise a
;;; sentence  name word ... !  name word ... !  with one group per named
;;; placeholder, in order (empty when nothing in the pattern was named).
;;; A placeholder is a word whose first character is one of
;;;   *   any number of words    &   at least one word
;;;   ?   at most one word        !   exactly one word
;;; and the rest of the word is its name (*rest, !x). When several splits work,
;;; the earlier placeholder takes as many words as possible. A name used twice
;;; must match the same words both times.
;;; Internally the names found so far are a list of (name . words), oldest first.

(define (%special? w)
  (and (word? w)
       (let ((s (word->string w)))
         (and (> (string-length s) 0)
              (memv (string-ref s 0) '(#\* #\& #\? #\!))
              #t))))

(define (%add-match name words known)
  (if (equal? name "")
      known
      (append known (list (cons name words)))))

;; the sentence after removing value from its front, or #f if it doesn't start with it
(define (%chop value sent)
  (cond ((null? value) sent)
        ((null? sent) #f)
        ((%same? (car value) (car sent)) (%chop (cdr value) (cdr sent)))
        (else #f)))

;; can a placeholder of this kind have matched these words?
(define (%length-ok? value kind)
  (cond ((null? value) (or (char=? kind #\?) (char=? kind #\*)))
        ((pair? (cdr value)) (or (char=? kind #\*) (char=? kind #\&)))
        (else #t)))

;; known names on success (possibly the empty list), #f on failure
(define (%match-from pattern sent known)
  (cond ((null? pattern) (if (null? sent) known #f))
        ((%special? (car pattern))
         (let* ((text (word->string (car pattern)))
                (kind (string-ref text 0))
                (name (string->word (substring text 1 (string-length text)))))
           (%match-placeholder kind name (cdr pattern) sent known)))
        ((null? sent) #f)
        ((%same? (car pattern) (car sent)) (%match-from (cdr pattern) (cdr sent) known))
        (else #f)))

(define (%match-placeholder kind name rest sent known)
  (let ((old (and (not (equal? name "")) (assoc name known))))
    (cond (old
           (and (%length-ok? (cdr old) kind)
                (let ((unmatched (%chop (cdr old) sent)))
                  (and unmatched (%match-from rest unmatched known)))))
          ((char=? kind #\?) (%match-longest name rest sent 0 #t known))
          ((char=? kind #\!) (%match-longest name rest sent 1 #t known))
          ((char=? kind #\*) (%match-longest name rest sent 0 #f known))
          (else (%match-longest name rest sent 1 #f known)))))

;; try the most words first, then one fewer each time, down to min
(define (%match-longest name rest sent min at-most-one? known)
  (if (null? sent)
      (and (= min 0) (%match-from rest sent (%add-match name '() known)))
      (let try ((matched (if at-most-one? (list (car sent)) sent))
                (unmatched (if at-most-one? (cdr sent) '())))
        (and (>= (length matched) min)
             (or (%match-from rest unmatched (%add-match name matched known))
                 (and (pair? matched)
                      (try (list-head matched (- (length matched) 1))
                           (cons (last matched) unmatched))))))))

(define (match pattern sent)
  (let ((known (%match-from pattern sent '())))
    (if known
        (apply append
               (map (lambda (entry) (append (list (car entry)) (cdr entry) '(!)))
                    known))
        'failed)))

;;; ---------------------------------------------------------------- trace

;; (trace f ...) makes each call of f print  (f arg ...)  and, when it returns,
;; the value, with calls inside calls indented by a bar per level:
;;   (f 2)
;;   |  (f 1)
;;   |  1
;;   2
;; (untrace f ...) puts the original back; tracing twice doesn't stack.
(define %trace-operations
  (let ((originals (make-strong-eqv-hash-table))
        (depth 0)
        (run -1))
    (define (original-of proc) (hash-table-ref/default originals proc proc))
    ;; an error that ends a run skips the unwinding below, so the level is
    ;; started again from the top whenever a new run begins
    (define (current-level)
      (if (not (= run (%run-number)))
          (begin (set! run (%run-number)) (set! depth 0)))
      depth)
    (define (indent n)
      (let loop ((i 0))
        (if (< i n) (begin (display "|  ") (loop (+ i 1))))))
    (define (wrap name proc)
      (if (not (procedure? proc)) (error "Not a procedure -- TRACE" name))
      (let* ((original (original-of proc))
             (wrapper
              (lambda args
                (let ((level (current-level)))
                  (fresh-line)
                  (indent level)
                  (display (cons name args))
                  (newline)
                  (let ((result (dynamic-wind
                                 (lambda () (set! depth (+ level 1)))
                                 (lambda () (apply original args))
                                 (lambda () (set! depth level)))))
                    (fresh-line)
                    (indent level)
                    (display result)
                    (newline)
                    result)))))
        (hash-table-set! originals wrapper original)
        wrapper))
    (cons wrap original-of)))
(define %book-trace-wrap (car %trace-operations))
(define %book-trace-original (cdr %trace-operations))

(define-syntax trace
  (syntax-rules ()
    ((_) (if #f #f))
    ((_ name rest ...) (begin (set! name (%book-trace-wrap 'name name)) (trace rest ...)))))
(define-syntax untrace
  (syntax-rules ()
    ((_) (if #f #f))
    ((_ name rest ...) (begin (set! name (%book-trace-original name)) (untrace rest ...)))))

;;; ---------------------------------------------------------------- text numbers

;; (strings-are-numbers #t) lets arithmetic and indexes accept text that reads as a
;; number, (strings-are-numbers #f) takes that away again. It is on from the moment
;; this library loads (the textbook's library does the same).
(define (strings-are-numbers yesno)
  (cond ((eq? yesno #t)
         (if (%text-numbers?)
             (show "Strings are already numbers")
             (%text-numbers! #t)))
        ((eq? yesno #f)
         (if (%text-numbers?)
             (%text-numbers! #f)
             (show "Strings are already not numbers")))
        (else (error "Strings-are-numbers: give a #t or a #f")))
  'okay)

(strings-are-numbers #t)
