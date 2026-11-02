module("lively.morphic.TextFormattingSupport")
  .requires(
    "lively.morphic.TextCore",
    "lively.morphic.TextFormattingToolbar",
  )
  .toRun(function () {

    // Wires the live formatting toolbar (lively.morphic.TextFormattingToolbar)
    // into lively.morphic.Text, replacing the Ctrl-L raw markup-spec editor
    // as the default way to format text. See TextMarkupEditorSpec.md at the
    // repo root for the full design and the reasoning below.
    //
    // Earlier version of this file introduced a real subclass,
    // lively.morphic.Text.subclass("lively.morphic.RichText", ...), for
    // scoping (only instances of the subclass show the toolbar, so input
    // lines/labels/button text elsewhere are unaffected) and persistence
    // safety (a real class keeps normal closures, unlike lively.BuildSpec,
    // matching the calendar app's Box.subclass-not-BuildSpec precedent for
    // inventory-published parts). That approach hit two problems, both
    // confirmed live rather than assumed:
    //
    // 1. NAME COLLISION: "lively.morphic.RichText" is already an unrelated
    //    internal class -- a plain value object (not a Morph) representing
    //    a chunk-based rich-text *string*, used by Text#getRichText() /
    //    #setRichText() (`new lively.morphic.RichText(str)`, TextCore.js
    //    ~2052). Defining a Text subclass under that same name silently
    //    clobbered it; `new lively.morphic.RichText(bounds)` then produced
    //    that broken value object instead of a Morph (no applyStyle,
    //    `instanceof Morph` false). Renaming to lively.morphic.FormattedText
    //    fixed this specific problem, but exposed the next one:
    //
    // 2. FRAMEWORK BUG WITH ANY lively.morphic.Text SUBCLASS: Text's own
    //    onFocus (TextCore.js "event handling" category) does
    //    `this.constructor.prototype.activeInstance = this`. For a plain
    //    Text instance this.constructor is lively.morphic.Text itself, so
    //    that's the same object the static reader
    //    `lively.morphic.Text.activeInstance()` (TextCore.js ~2678,
    //    `return this.prototype.activeInstance`) reads back from -- but for
    //    ANY subclass, this.constructor is the subclass, so onFocus writes
    //    to the *subclass's* prototype while activeInstance() always reads
    //    lively.morphic.Text's own prototype specifically. The two never
    //    meet. Confirmed live (blank.html, a throwaway FormattedText
    //    instance, driven with real clicks via chrome-devtools CLI): after
    //    a genuine focus + real double-click word selection (window
    //    .getSelection().toString() correctly returned "world"),
    //    Text#isFocused() (`lively.morphic.Text.activeInstance() === this`)
    //    still returned false, and Text#getSelectionRange() -- which bails
    //    out to `this.priorSelectionRange` whenever `!this.isFocused()`
    //    (TextCore.js:1685) -- returned undefined instead of the real
    //    selection. This isn't specific to our subclass; it would break
    //    identically for any lively.morphic.Text subclass that relies on
    //    isFocused()/getSelectionRange() (e.g. a future one), and plausibly
    //    already affects existing subclasses like
    //    lively.morphic.ColorChooserSwitcher (ColorChooserDraft.js) if they
    //    ever exercise this path -- not checked, flagging as a suspect
    //    rather than a confirmed second casualty.
    //
    //    The real fix belongs in TextCore.js's onFocus (write to
    //    lively.morphic.Text.prototype.activeInstance directly, not
    //    this.constructor.prototype), but that's a shared-framework change
    //    with system-wide blast radius and deserves its own deliberate
    //    change/review, not a drive-by inside this feature. Documented here
    //    and in TextMarkupEditorSpec.md as a known pre-existing bug to fix
    //    separately.
    //
    // SIDESTEP CHOSEN INSTEAD: no subclass at all. Add onFocusAction /
    // onBlurAction to lively.morphic.Text itself (the existing extension
    // points TextCore.js's registerForFocusAndBlurEvents already calls
    // unconditionally: "self.onFocusAction && self.onFocusAction()"), but
    // gate the toolbar behind a plain per-instance boolean flag,
    // richTextToolbarEnabled. This keeps the identical scoping guarantee a
    // subclass was meant to provide -- input lines/labels/button text never
    // set the flag, so they're never affected -- without creating a new
    // class at all, so `this.constructor` stays lively.morphic.Text for
    // every instance and the activeInstance bug above never triggers.
    // Persistence safety is unaffected: a boolean instance property
    // serializes fine (unlike a closure), same as any other Text style flag.
    // Replaces the browser's native focus ring (a black `outline: auto` that
    // Main.js puts on every `.visibleSelection:focus`) with a pink glow, for
    // rich text morphs only. Done as a scoped CSS class rather than a JS style
    // write on the inner editable node, which is rebuilt on re-render.
    var GLOW_CLASS = "rich-text-glow";
    function ensureGlowCss() {
      var STYLE_ID = "rich-text-glow-style";
      if (document.getElementById(STYLE_ID)) return;
      var styleEl = document.createElement("style");
      styleEl.id = STYLE_ID;
      styleEl.textContent = [
        ".Text." + GLOW_CLASS + " .visibleSelection:focus {",
        "  outline: none;",
        "  border-radius: 7px;",
        "  box-shadow: 0 0 0 1px rgba(255,64,160,0.9), 0 0 10px 3px rgba(255,64,160,0.55);",
        "}"
      ].join("\n");
      document.head.appendChild(styleEl);
    }

    // A text whose height should hug its content (fixedHeight false) only
    // re-fits on key-up and when added to the world. Pasting, cutting, undo,
    // and every toolbar format change (font size, family, ...) rewrite the
    // content without either, leaving the box taller or shorter than its
    // text. Watch the content and re-fit, debounced. Mutations of the text
    // node's own attributes are ignored: those are fit()'s own writes
    // (setTextNodeToFitMorphExtent), and reacting to them would loop. The
    // observer lives on the DOM node, not the morph, so it is never
    // serialized and a re-rendered node simply gets a fresh one.
    function watchContentSize(text) {
      var node = text.renderContext() && text.renderContext().textNode;
      if (!node || node._richTextFitObserver || typeof MutationObserver === "undefined") return;
      var pending = null;
      var observer = new MutationObserver(function (records) {
        if (!records.some(function (r) { return r.target !== node; })) return;
        if (pending) return;
        pending = setTimeout(function () {
          pending = null;
          if (text.world()) text.fit();
        }, 40);
      });
      observer.observe(node, {
        childList: true, characterData: true, subtree: true,
        attributes: true, attributeFilter: ["style", "class"]
      });
      node._richTextFitObserver = observer;
    }

    // setExtent and fit are overridden below, but they are Text's own
    // methods: inside addMethods, $super means the SUPERCLASS's method
    // (Morph's), which has no fit() at all and would skip Text's own
    // setExtent. So call the originals directly. Kept on the prototype so a
    // module reload doesn't capture (and then recurse into) its own override.
    var TextProto = lively.morphic.Text.prototype;
    if (!TextProto._richTextOriginals) {
      Object.defineProperty(TextProto, "_richTextOriginals", {
        value: { setExtent: TextProto.setExtent, fit: TextProto.fit },
        enumerable: false
      });
    }
    var ORIGINAL = TextProto._richTextOriginals;
    // a module reload keeps the object above, so add later originals separately
    if (!ORIGINAL.onEnterPressed) {
      ORIGINAL.onEnterPressed = TextProto.onEnterPressed;
      ORIGINAL.onMouseUp = TextProto.onMouseUp;
      ORIGINAL.onKeyUp = TextProto.onKeyUp;
    }

    // -- lists ----------------------------------------------------------
    // A rich text morph is a flat run of styled chunks with no block
    // structure, so a list is made of ordinary text: each list line starts
    // with a marker ("• ", "3. ", "☐ "/"☑ "). That keeps lists
    // inside the existing text/markup model (they save, copy and serialize
    // like any other characters). Enter continues a list, Enter on an empty
    // item ends it, and clicking a to-do box ticks it.
    //
    // The space after a marker is a NON-BREAKING space (SP), and ONLY that
    // form counts as a marker. Two reasons: in a text with white-space
    // "normal" (the calendar memo field) the browser drops a collapsible
    // space at the end of a line as soon as you type after it, and a marker
    // that a user typed by hand ("- ", "1. ", a pasted bullet) uses a plain
    // space, so requiring the nbsp is what tells a list item the toolbar
    // made from ordinary text that merely starts the same way.
    var SP = "\u00a0";
    var LIST_KINDS = {
      bullet: /^\u2022\u00a0/,
      number: /^\d+\.\u00a0/,
      check: /^[\u2610\u2611]\u00a0/
    };
    var CHECK_OFF = "\u2610", CHECK_ON = "\u2611";

    // the list marker at the start of `line`: {kind, text} or null
    function markerOf(line) {
      for (var kind in LIST_KINDS) {
        var m = LIST_KINDS[kind].exec(line);
        if (m) return { kind: kind, text: m[0] };
      }
      return null;
    }
    function lineStartOf(text, idx) {
      return idx <= 0 ? 0 : text.lastIndexOf("\n", idx - 1) + 1;
    }
    function lineEndOf(text, idx) {
      var nl = text.indexOf("\n", idx);
      return nl < 0 ? text.length : nl;
    }
    // marker to put on the line after a line carrying `marker`
    function nextMarkerText(marker) {
      if (marker.kind === "bullet") return "\u2022" + SP;
      if (marker.kind === "check") return CHECK_OFF + SP;
      return (parseInt(marker.text, 10) + 1) + "." + SP;
    }

    lively.morphic.Text.addMethods("rich text formatting toolbar", {
      // Resizing (e.g. dragging a halo handle) reflows the text but never
      // re-fit the height, so widening a box left it as tall as it was when
      // the text was still wrapped into more lines.
      setExtent: function setExtent(value) {
        var result = ORIGINAL.setExtent.call(this, value);
        if (this.richTextToolbarEnabled && this.fixedWidth && !this.fixedHeight) this.fit();
        return result;
      },
      // fit() measures through getTextExtent(), which clears the text node's
      // max-width and only puts it back for white-space "pre" (HTML.js). A
      // fixed-width text is left uncapped, so its lines run out to the box's
      // right edge, past the right padding. Put the cap back after measuring.
      // The measurement was taken WITHOUT the cap, so it can count fewer
      // lines than the capped text really wraps into: read the real rendered
      // height back and correct the box. The busy flag (on the DOM node, so
      // it isn't serialized) keeps fit, the setExtent hook above and this
      // correction from re-triggering each other.
      // The correction only runs once the text node is attached to the page.
      // While a saved world is being rendered, setExtent runs from initHTML
      // with the morph already in the world but its node not yet in the DOM,
      // where offsetHeight reads 0: the box would be set to border + padding
      // alone (12px) and the text would hang out below it.
      fit: function fit() {
        if (!this.richTextToolbarEnabled || !this.fixedWidth) return ORIGINAL.fit.call(this);
        var node = this.renderContext() && this.renderContext().textNode;
        if (node && node._richTextFitBusy) return;
        if (node) node._richTextFitBusy = true;
        try {
          var result = ORIGINAL.fit.call(this);
          this.setTextNodeToFitMorphExtent();
          if (node && node.isConnected && this.world() && !this.fixedHeight) {
            var padding = this.getPadding(),
                want = node.offsetHeight + this.getBorderWidth() * 2 + padding.top() + padding.bottom(),
                extent = this.getExtent();
            if (Math.abs(extent.y - want) > 1) ORIGINAL.setExtent.call(this, lively.pt(extent.x, want));
          }
          return result;
        } finally {
          if (node) node._richTextFitBusy = false;
        }
      },
      // -- formatting with only a caret ("pending" emphasis) ----------------
      // Bold, size, color, font... applied while nothing is selected style
      // the characters typed next, as in Google Docs, instead of doing
      // nothing. The pending style is {spec, start, caret, length}: the caret
      // it was set at, where typing began, and the text length then, so a
      // key-up can tell "typed N characters at the caret" from "the caret
      // moved / something else changed" (which drops it). Kept non-enumerable
      // so it is never serialized with the morph.
      _setPendingEmphasis: function _setPendingEmphasis(p) {
        Object.defineProperty(this, "_pendingEmphasis", { value: p, writable: true, enumerable: false, configurable: true });
      },

      // The pending spec if it still applies at the current caret, else null.
      // Read-only on purpose: the toolbar polls this between a character
      // landing and its key-up, and must not discard the style in that gap.
      getPendingEmphasis: function getPendingEmphasis() {
        var p = this._pendingEmphasis;
        if (!p) return null;
        var range = this.getSelectionRange();
        if (!range || range[0] !== range[1]) return null;
        if (range[0] === p.caret && this.textString.length === p.length) return p.spec;
        return null;
      },

      // Emphasis of the text a collapsed caret would type into: the
      // character before it (or the first one at the very start).
      getEmphasisForCaret: function getEmphasisForCaret(caret) {
        return this.getEmphasisAt(caret > 0 ? caret - 1 : 0);
      },

      // Apply `spec` to `range` ([from, to], defaults to the selection): a
      // real range is emphasized now, a bare caret makes it pending.
      emphasizeRangeOrPending: function emphasizeRangeOrPending(spec, range) {
        if (!range) return;
        var a = Math.min(range[0], range[1]), b = Math.max(range[0], range[1]);
        if (a !== b) {
          this._setPendingEmphasis(null);
          if (this.isFocused()) this.emphasizeSelection(spec);
          else this.emphasize(spec, a, b);
          return;
        }
        var p = this._pendingEmphasis;
        if (p && p.caret === a && p.length === this.textString.length) {
          if (p.start === a) {
            Object.extend(p.spec, spec); // nothing typed yet: just add to it
          } else {
            // characters were already typed under the old style; the new
            // choice must only affect what comes after them, so start a new
            // segment here that carries the old style forward
            this._setPendingEmphasis({ spec: Object.extend(Object.extend({}, p.spec), spec), start: a, caret: a, length: p.length });
          }
        } else {
          this._setPendingEmphasis({ spec: Object.extend({}, spec), start: a, caret: a, length: this.textString.length });
        }
      },
      emphasizeOrPending: function emphasizeOrPending(spec) {
        this.emphasizeRangeOrPending(spec, this.getSelectionRange());
      },

      // Bold / italic / underline / link. With a selection this is the plain
      // toggle; with a caret it flips the pending (or current) state; Link
      // needs text to attach to, so a caret first selects the word under it.
      toggleEmphasisOrPending: function toggleEmphasisOrPending(type) {
        var range = this.getSelectionRange();
        if (!range) return;
        if (range[0] !== range[1]) {
          this._setPendingEmphasis(null);
          this.toggleEmphasisForSelection(type);
          return;
        }
        var spec = {
          Boldness: { key: "fontWeight", on: "bold", read: function (e) { return e.getFontWeight(); } },
          Italics: { key: "italics", on: "italic", read: function (e) { return e.getItalics(); } },
          Underline: { key: "textDecoration", on: "underline", read: function (e) { return e.getTextDecoration(); } }
        }[type];
        if (!spec) { // Link
          var w = this.selectWord(this.textString, range[0]);
          if (!w || !this.textString.slice(w[0], w[1] + 1).trim()) return;
          this.setSelectionRange(w[0], w[1] + 1);
          this.toggleEmphasisForSelection(type);
          return;
        }
        var pending = this.getPendingEmphasis();
        var emph = this.getEmphasisForCaret(range[0]);
        var isOn = pending && pending[spec.key] !== undefined ? pending[spec.key] === spec.on : !!emph && spec.read(emph) === spec.on;
        var change = {};
        change[spec.key] = isOn ? "normal" : spec.on;
        this.emphasizeRangeOrPending(change, range);
      },

      // Key-up after typing: give the characters just typed the pending
      // style (the whole run since it was set, so a held key is covered),
      // or drop it if the caret moved or the text changed some other way.
      _settlePendingEmphasis: function _settlePendingEmphasis() {
        var p = this._pendingEmphasis;
        if (!p) return;
        var range = this.getSelectionRange();
        if (!range || range[0] !== range[1]) { this._setPendingEmphasis(null); return; }
        var caret = range[0], len = this.textString.length, grew = len - p.length;
        if (grew > 0 && caret === p.caret + grew) {
          this.emphasize(p.spec, p.start, caret);
          this.setSelectionRange(caret, caret);
          p.caret = caret;
          p.length = len;
        } else if (caret !== p.caret || len !== p.length) {
          this._setPendingEmphasis(null);
        }
      },
      onKeyUp: function onKeyUp(evt) {
        var result = ORIGINAL.onKeyUp.call(this, evt);
        if (this.richTextToolbarEnabled) this._settlePendingEmphasis();
        return result;
      },

      // Replace [from, to) with `str` through the DOM selection, so the new
      // characters pick up the style of the text around them (setting
      // textString would drop every emphasis).
      replaceRangeKeepingStyle: function replaceRangeKeepingStyle(from, to, str) {
        if (from === to && !str) return;
        this.setSelectionRange(from, to);
        this.insertAtCursor(str, false, true);
      },

      // Toggle a list of `kind` ("bullet" | "number" | "check", or "none" to
      // strip any list marker) on every line the selection touches. If all
      // of them already have that kind, it is removed instead; lines with a
      // different kind are converted. Numbers continue from a numbered line
      // directly above the selection.
      toggleListForSelection: function toggleListForSelection(kind) {
        var text = this.textString;
        var range = this.getSelectionRange() || [0, 0];
        var a = Math.min(range[0], range[1]), b = Math.max(range[0], range[1]);
        var limit = b > a ? b - 1 : a; // a line that starts exactly at the selection end isn't touched
        var lines = [], i = lineStartOf(text, a);
        while (i <= limit) {
          var end = lineEndOf(text, i);
          lines.push({ start: i, marker: markerOf(text.slice(i, end)) });
          if (end >= text.length) break;
          i = end + 1;
        }
        if (!lines.length) return;
        var removing = kind === "none" || lines.every(function (l) { return l.marker && l.marker.kind === kind; });

        var n = 1;
        if (kind === "number" && lines[0].start > 0) {
          var prevStart = lineStartOf(text, lines[0].start - 1);
          var prev = markerOf(text.slice(prevStart, lines[0].start - 1));
          if (prev && prev.kind === "number") n = parseInt(prev.text, 10) + 1;
        }
        lines.forEach(function (l) {
          var m;
          if (removing) m = "";
          else if (kind === "bullet") m = "\u2022" + SP;
          else if (kind === "check") m = (l.marker && l.marker.kind === "check" ? l.marker.text.charAt(0) : CHECK_OFF) + SP;
          else m = (n++) + "." + SP;
          l.newText = m;
          l.delta = m.length - (l.marker ? l.marker.text.length : 0);
        });

        if (this.logChangeForUndo) this.logChangeForUndo();
        // last line first, so the earlier offsets stay valid
        for (var k = lines.length - 1; k >= 0; k--) {
          var l = lines[k];
          if (l.newText === (l.marker ? l.marker.text : "")) continue;
          this.replaceRangeKeepingStyle(l.start, l.start + (l.marker ? l.marker.text.length : 0), l.newText);
        }
        var total = lines.reduce(function (s, l) { return s + l.delta; }, 0);
        var newA = Math.max(lines[0].start, a + lines[0].delta);
        this.setSelectionRange(newA, Math.max(newA, b + total));
        this.cachedTextString = null;
        this.fit();
      },

      // Enter in a list line: start the next item, or, on an item with no
      // text, end the list (the marker is removed instead of continuing it).
      onEnterPressed: function onEnterPressed(evt) {
        if (!this.richTextToolbarEnabled || this.isInputLine || evt.isCommandKey()) {
          return ORIGINAL.onEnterPressed.call(this, evt);
        }
        var range = this.getSelectionRange(), text = this.textString;
        if (!range || range[0] !== range[1]) return ORIGINAL.onEnterPressed.call(this, evt);
        var caret = range[0], ls = lineStartOf(text, caret), le = lineEndOf(text, caret);
        var marker = markerOf(text.slice(ls, le));
        if (!marker || caret < ls + marker.text.length) return ORIGINAL.onEnterPressed.call(this, evt);
        if (le === ls + marker.text.length) { // nothing after the marker: end the list
          this.replaceRangeKeepingStyle(ls, le, "");
          this.setSelectionRange(ls, ls);
          this.cachedTextString = null;
          evt.stop();
          return true;
        }
        var result = ORIGINAL.onEnterPressed.call(this, evt);
        this.insertAtCursor(nextMarkerText(marker), false, false);
        return result;
      },

      // Clicking on (or just before/after) a to-do box ticks / unticks it.
      onMouseUp: function onMouseUp(evt) {
        if (this.richTextToolbarEnabled) this._setPendingEmphasis(null);
        if (this.richTextToolbarEnabled && this.toggleCheckboxAtCaret()) return false;
        return ORIGINAL.onMouseUp.call(this, evt);
      },
      toggleCheckboxAtCaret: function toggleCheckboxAtCaret() {
        var range = this.getSelectionRange();
        if (!range || range[0] !== range[1]) return false;
        var text = this.textString, caret = range[0], ls = lineStartOf(text, caret);
        var marker = markerOf(text.slice(ls, lineEndOf(text, caret)));
        if (!marker || marker.kind !== "check" || caret > ls + 1) return false;
        var ticked = marker.text.charAt(0) === CHECK_ON;
        this.replaceRangeKeepingStyle(ls, ls + 1, ticked ? CHECK_OFF : CHECK_ON);
        this.setSelectionRange(caret, caret);
        this.priorSelectionRange = [caret, caret];
        this.cachedTextString = null;
        return true;
      },

      onFocusAction: function onFocusAction() {
        if (!this.richTextToolbarEnabled) return;
        // also here, not just in enableFormattingToolbar: a morph restored
        // from a saved world has the flag but never had that method called
        ensureGlowCss();
        this.addStyleClassName(GLOW_CLASS);
        watchContentSize(this);
        lively.morphic.TextFormattingToolbar.showFor(this);
      },
      onBlurAction: function onBlurAction() {
        if (!this.richTextToolbarEnabled) return;
        lively.morphic.TextFormattingToolbar.hideForSoon(this);
      },
      enableFormattingToolbar: function enableFormattingToolbar() {
        this.richTextToolbarEnabled = true;
        ensureGlowCss();
        this.addStyleClassName(GLOW_CLASS);
        watchContentSize(this);
        return this;
      },
      disableFormattingToolbar: function disableFormattingToolbar() {
        this.richTextToolbarEnabled = false;
        return this;
      },
    });

  });
