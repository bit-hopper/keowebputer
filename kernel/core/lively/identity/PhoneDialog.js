/**
 * lively.identity.PhoneDialog
 *
 * WarpDrop: the window for receiving files from a phone over the local network. Inside the desktop app only: the app runs a small
 * web server while this window is open (shell/keo-phone.js starts and stops it, lib/phone.js in keo-desktop is the server). The phone
 * scans the code shown here, opens the page it gets, chooses files and sends them. This window only DRAWS: the code, who connected,
 * progress and the result. The QUESTION about every batch of files ("Allow 3 files from ...?") is the shell's, drawn over everything, and
 * only a real click there lets a byte in: this window is part of the world, which is less trusted than the shell, so nothing here can
 * say yes for the person. It is told no file names and gets no bytes; what arrives is kept by the shell in a folder called Dropped in
 * My files, where it waits until the person looks at it.
 *
 * Closing the window stops the server (a server with no window could not be seen or stopped), and the address stops working.
 * Once a phone has opened the page the code is hidden: the page belongs to that phone, another device is turned away.
 *
 * What it shows: a strip at the top that is about the PHONE (nobody yet, or the one that opened the page, with one state word), and
 * under it what is happening: the code and the steps, the wait for the phone to choose, the question being up, the bar, the result or
 * the problem. The look follows PeerDialog (Connect a device): the same window, the same fonts, plain buttons, and a green main button.
 *
 * Async convention: thenDo(err, result) throughout.
 *
 * Dependencies:
 *   lively.identity.LocalIdentity — the shell calls (phoneStart, phoneStop, onPhoneEvent)
 */

module("lively.identity.PhoneDialog")
  .requires(
    "lively.identity.LocalIdentity",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    // Constants and helpers that do not draw: the methods of a BuildSpec are rebuilt from their own source text and lose this wrapper's
    // closure (see AmbientPresencePanel), so whatever they share is reached by a dotted path, never by a variable of this function.
    Object.extend(lively.identity.PhoneDialog, {
      FOLDER: "Dropped",
      FONT: "Arial, sans-serif",
      MONO: "Menlo, Consolas, monospace",
      ICONS: "'Material Symbols Rounded'",
      W: 474,          // the content's width; the window adds its frame
      PAD: 14,
      INNER: 446,      // W - 2 * PAD
      LINE: 18,        // the height one line of body text is given (12 px text): a flat measured value, see the kernel notes on Text height
      C: {
        text: Color.rgb(70, 70, 70), strong: Color.rgb(50, 50, 50), muted: Color.rgb(119, 119, 119), faint: Color.rgb(138, 138, 138),
        line: Color.rgb(203, 203, 203), btnLine: Color.rgb(214, 214, 214), track: Color.rgb(226, 226, 226),
        green: Color.rgb(47, 158, 91), white: Color.white, frame: Color.rgb(255, 16, 144),
        hintBg: Color.rgb(255, 247, 230), hintLine: Color.rgb(240, 217, 168), hintTitle: Color.rgb(94, 63, 8)
      },
      // the state colours: a soft background and a strong foreground each. Never pink: pink is the window's, these say what is going on.
      TONES: {
        grey:  { bg: Color.rgb(236, 236, 236), fg: Color.rgb(107, 107, 107) },
        green: { bg: Color.rgb(226, 244, 234), fg: Color.rgb(30, 122, 70) },
        amber: { bg: Color.rgb(253, 240, 210), fg: Color.rgb(122, 84, 16) },
        red:   { bg: Color.rgb(251, 227, 227), fg: Color.rgb(176, 42, 42) }
      },

      // The width a string takes in the window's own font, measured on a canvas (no need to wait for the page to lay anything out).
      textW: function textW(str, px, bold, mono) {
        var NS = lively.identity.PhoneDialog, c = NS._cv || (NS._cv = document.createElement("canvas")), g = c.getContext("2d");
        g.font = (bold ? "bold " : "") + px + "px " + (mono ? NS.MONO : NS.FONT);
        return g.measureText(String(str)).width;
      },
      // How many lines a paragraph takes at a width (greedy, on spaces: how the browser breaks it). Used to give a text its height.
      lineCount: function lineCount(str, px, maxW, bold) {
        var NS = lively.identity.PhoneDialog, n = 1, line = "";
        String(str).split(" ").forEach(function (wd) {
          var tried = line ? line + " " + wd : wd;
          if (line && NS.textW(tried, px, bold) > maxW) { n++; line = wd; } else line = tried;
        });
        return n;
      },
      // Sizes the way the question says them (1000 to the unit, one decimal below 100), so the two never disagree.
      sizeText: function sizeText(n) {
        n = Math.max(0, Number(n) || 0);
        if (n < 1000) return n + " bytes";
        var u = ["KB", "MB", "GB", "TB"], i = -1;
        do { n /= 1000; i++; } while (n >= 1000 && i < u.length - 1);
        return (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10) + " " + u[i];
      },
      // "198 of 412 MB": the unit is said once when both numbers share it.
      sizePair: function sizePair(done, total) {
        var NS = lively.identity.PhoneDialog, a = NS.sizeText(done), b = NS.sizeText(total);
        return (a.split(" ")[1] === b.split(" ")[1] ? a.split(" ")[0] : a) + " of " + b;
      },
      leftText: function leftText(s) {
        s = Math.max(1, Math.round(s));
        if (s < 60) return "about " + s + " s";
        if (s < 5400) return "about " + Math.round(s / 60) + " min";
        return "about " + Math.round(s / 3600) + " h";
      },
      // Bytes a second from what the window was told and when (the last few seconds of it). An estimate: null until there is enough to say.
      speedOf: function speedOf(samples) {
        if (!samples || samples.length < 2) return null;
        var a = samples[0], b = samples[samples.length - 1], dt = (b.t - a.t) / 1000;
        if (dt < 0.7 || b.done <= a.done) return null;
        return (b.done - a.done) / dt;
      },
      plural: function plural(n, one, many) { return n + " " + (n === 1 ? one : many); },
      // The shell says "a phone or tablet" or "a device": a sentence's start wants a capital.
      capital: function capital(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); },

      // What the result says, for any numbers: a headline, short sentences, and how it should look (green, amber for a mixed result,
      // red when nothing was saved and something failed).
      resultWords: function resultWords(r) {
        var NS = lively.identity.PhoneDialog, n = r.count || 0, e = r.existed || 0, f = r.failed || 0, folder = r.folder || NS.FOLDER;
        var title = n > 0 ? NS.plural(n, "file", "files") + " saved" : e > 0 ? "Already in your files" : "Nothing was saved";
        var inFolder = " in the " + folder + " folder of My files.", parts = [];
        if (n > 0 && !e && !f) parts.push((n === 1 ? "It is" : "They are") + inFolder + " Nothing has been opened.");
        if (n === 0 && e > 0) parts.push((e === 1 ? "This file was" : "These files were") + " already in your files, so nothing new was added.");
        if (n > 0 && e > 0) parts.push(NS.plural(e, "file was", "files were") + " already in your files.");
        if (f > 0) parts.push(NS.plural(f, "file", "files") + " could not be saved.");
        if (n > 0 && (e || f)) parts.push((n === 1 ? "The saved file is" : "The saved files are") + inFolder);
        var tone = f > 0 && !n && !e ? "red" : f > 0 ? "amber" : "green";
        return { title: title, text: parts.join(" "), tone: tone, icon: tone === "green" ? "check" : tone === "amber" ? "warning" : "error" };
      },
      // The cards for what went wrong. The window stays "Connected": the phone is still there, it only has to send again.
      PROBLEMS: {
        declined:  { tone: "grey",  icon: "block",        title: "You declined", text: "The phone was told. It can send something else." },
        cancelled: { tone: "amber", icon: "pause_circle", title: "The phone stopped sending", text: "Files that were already saved stay in the Dropped folder." },
        timeout:   { tone: "amber", icon: "timer_off",    title: "You did not answer in time", text: "The question waits 2 minutes. The phone was told the transfer was cancelled. It can send again." },
        space:     { tone: "red",   icon: "storage",      title: "Not enough room", text: "The phone tried to send more than this webputer has space for, and was told no. Free some space and send again." },
        failed:    { tone: "red",   icon: "error",        title: "A file did not finish", text: "The phone can try again." },
        refused:   { tone: "red",   icon: "error",        title: "The phone was told no", text: "This webputer could not take what the phone offered." },
        app:       { tone: "red",   icon: "error",        title: "Something went wrong", text: "keo could not reach the app that talks to the phone." }
      }
    });

    lively.BuildSpec("lively.identity.PhoneDialog", {
      _BorderRadius: 7,
      _Extent: lively.pt(480, 200),
      _Fill: Color.rgb(255, 16, 144),
      // Above every other morph (see PeerDialog): a world may give its own morphs an explicit z-index.
      _ZIndex: 1000,
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "IdentityPhoneDialog",
      titleBar: "WarpDrop",
      submorphs: [
        {
          _Extent: lively.pt(474, 172),
          _Fill: Color.rgb(250, 250, 250),
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          layout: {
            adjustForNewBounds: true,
            resizeHeight: true,
            resizeWidth: true,
          },
          name: "phoneContent",
          submorphs: [],
        },
      ],

      // ─── lifecycle ──────────────────────────────────────────────────────────────

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        // see LoginDialog: skipping $super() leaves the window without a title bar
        $super();
        var self = this;
        this._ensureAccentChromeCss();
        this.addStyleClassName("identity-accent-chrome");
        this._p = this._freshState();
        // Events are not queued by the shell: this window listens from the start (and asks for the state at hand once it is running).
        this._stopListening = lively.identity.localIdentity.onPhoneEvent(function (ev) { self.onPhoneEvent(ev); });
        this.begin();   // draws "Starting …" at once, then the code when the shell has started the server
      },

      // Closing the window stops the server. remove() also runs when the window is only brought forward (taken out and put back at
      // once), and that must not end anything: the teardown waits one tick and is skipped if the window is back in the world (the same
      // way PeerDialog does it). $super() still runs at once.
      remove: function remove() {
        var self = this;
        $super();
        setTimeout(function () {
          if (self.world()) return;
          if (self._stopListening) { self._stopListening(); self._stopListening = null; }
          if (self._hintTimer) { clearTimeout(self._hintTimer); self._hintTimer = null; }
          if (self._copyTimer) { clearTimeout(self._copyTimer); self._copyTimer = null; }
          if (self._p && self._p.phase !== "closed") { self._p.phase = "closed"; lively.identity.localIdentity.phoneStop(); }
        }, 0);
      },

      _ensureAccentChromeCss: function () {
        var STYLE_ID = "identity-accent-chrome-style";
        if (document.getElementById(STYLE_ID)) return;
        var styleEl = document.createElement("style");
        styleEl.id = STYLE_ID;
        styleEl.textContent = [
          ".Window.identity-accent-chrome .Text.window-title { color: #fff; }",
          ".Window.identity-accent-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }",
        ].join("\n");
        document.head.appendChild(styleEl);
      },

      // What the window knows. step is what the body shows while the server runs: waiting, connected, asked, receiving, saving, done or
      // problem. phase is the server's: starting, running, error, expired, signedout, closed.
      _freshState: function _freshState() {
        return { phase: "starting", urls: [], qrs: [], ix: 0, claimed: false, phone: null, step: "waiting", hint: false,
          ask: null, rx: null, saving: null, result: null, problem: null, error: null };
      },

      // Starts the server through the shell and shows the code. The shell answers for a server that is already running too.
      begin: function begin() {
        var self = this, NS = lively.identity.PhoneDialog;
        if (this._hintTimer) { clearTimeout(this._hintTimer); this._hintTimer = null; }
        this._p = this._freshState();
        this.render();
        lively.identity.localIdentity.phoneStart(function (err, r) {
          var p = self._p;
          if (!self.world()) { if (!err) lively.identity.localIdentity.phoneStop(); return; }
          if (p.phase === "closed") return;
          if (err) { p.phase = "error"; p.error = err.message || String(err); return self.render(); }
          p.phase = "running"; p.urls = r.urls || []; p.qrs = r.qrs || []; p.ix = 0;
          p.claimed = !!r.claimed;
          p.phone = r.claimed && r.phone ? { who: NS.capital(r.phone.who), ip: r.phone.ip } : null;
          p.step = r.asking ? "asked" : p.claimed ? "connected" : "waiting";
          self._autoPos = null;   // the first full drawing places the window afresh: it was centred for its small first size
          self.render();
          if (!p.claimed && p.urls.length) {
            self._hintTimer = setTimeout(function () {
              if (self.world() && !self._p.claimed && self._p.phase === "running") { self._p.hint = true; self.render(); }
            }, 30000);
          }
        });
      },

      // "New code" and "Try again": the same as opening the window afresh (the shell makes a new address if the old one ran out).
      tryAgain: function tryAgain() { this.begin(); },

      useAddress: function useAddress(i) { this._p.ix = i; this.render(); },

      // The address on the clipboard; the button says so for a moment (the same call as Connect a device's Copy).
      copyAddress: function copyAddress() {
        var self = this, p = this._p;
        lively.identity.localIdentity.copyText(p.urls[p.ix] || p.urls[0] || "", function (ok) {
          var b = self.get("copyBtn");
          if (!b) return;
          b.setLabel(ok ? "Copied" : "Not copied");
          if (self._copyTimer) clearTimeout(self._copyTimer);
          self._copyTimer = setTimeout(function () { var again = self.get("copyBtn"); if (again) again.setLabel("Copy"); }, 1800);
        });
      },

      // What arrived is in My files, in the Dropped folder: open it there.
      showFiles: function showFiles() {
        var folder = (this._p.result && this._p.result.folder) || lively.identity.PhoneDialog.FOLDER;
        lively.require("lively.identity.MyFilesBrowser").toRun(function () {
          lively.identity.MyFilesBrowser.openOnFolder(folder);
        });
      },

      // ─── drawing ────────────────────────────────────────────────────────────────

      // The whole content is drawn again for each change of what is shown; a progress update only moves the bar and its words
      // (updateProgress). The window is sized to its content: the window's extent is set first, because its layout stretches the
      // content by the change of its height, and the content's extent last (the same as PeerDialog).
      render: function render() {
        var content = this.get("phoneContent"), p = this._p, NS = lively.identity.PhoneDialog, local = lively.identity.localIdentity;
        if (!content) return;
        content.removeAllMorphs();
        var y = NS.PAD, main = null;
        var phoneStrip = function (chip, tone, av) {
          return { name: p.phone ? p.phone.who : "A phone or tablet", line: (p.phone ? p.phone.ip : "") + " · not verified", chip: chip, tone: tone, av: av };
        };
        if (!local.isAvailable()) {
          y = this._note(content, y, "Connecting a phone needs keo webputer.", false);
        } else if (p.phase === "starting") {
          y = this._note(content, y, "Starting …", false);
        } else if (p.phase === "signedout") {
          y = this._note(content, y, "Stopped: you were signed out.", true);
        } else if (p.phase === "error") {
          y = this._strip(content, y, { name: "No phone yet", line: "Could not start", chip: "Stopped", tone: "red", av: "grey" });
          y = this._card(content, y + 12, "red", "error", "Could not start", p.error || "Something went wrong.", false);
          main = { label: "Try again", name: "mainBtn", method: "tryAgain", kind: "plain", w: 110 };
        } else if (p.phase === "expired") {
          y = this._strip(content, y, { name: p.phone ? p.phone.who : "No phone yet", line: "The address no longer works", chip: "Stopped", tone: "red", av: "grey" });
          y = this._card(content, y + 12, "grey", "timer_off", "The code ran out", "Nothing happened for 10 minutes, so the address stopped working.", false);
          main = { label: "New code", name: "mainBtn", method: "tryAgain", kind: "main", w: 110 };
        } else if (!p.urls.length) {
          y = this._strip(content, y, { name: "No phone yet", line: "No network to share on", chip: "Not reachable", tone: "red", av: "grey" });
          y = this._card(content, y + 12, "red", "wifi_off", "No network address", "This webputer has no address a phone could reach. Connect it to Wi-Fi or a cable, then try again.", false);
          main = { label: "Try again", name: "mainBtn", method: "tryAgain", kind: "plain", w: 110 };
        } else if (p.step === "waiting") {
          y = this._strip(content, y, { name: "No phone yet", line: "Waiting for a phone to open the page", chip: "Waiting", tone: "grey", av: "grey" });
          y = this._waiting(content, y + 12);
        } else if (p.step === "connected") {
          y = this._strip(content, y, phoneStrip("Connected", "green", "green"));
          y = this._waitBox(content, y + 12, "Waiting for the phone to choose files", "This webputer asks you before it takes anything.");
        } else if (p.step === "asked") {
          y = this._strip(content, y, phoneStrip("Asking you", "amber", "amber"));
          var a = p.ask;
          y = this._card(content, y + 12, "amber", "notifications_active", "Your answer is needed",
            (a ? NS.plural(a.count, "file", "files") + " (" + NS.sizeText(a.total) + ") " + (a.count === 1 ? "is" : "are") + " waiting. " : "") +
            "The question is on the screen. Nothing is taken until you accept.", false);
        } else if (p.step === "receiving") {
          y = this._strip(content, y, phoneStrip("Receiving", "green", "green"));
          y = this._receiving(content, y + 12);
        } else if (p.step === "saving") {
          y = this._strip(content, y, phoneStrip("Saving", "green", "green"));
          y = this._saving(content, y + 12);
        } else if (p.step === "done") {
          var res = NS.resultWords(p.result || {});
          y = this._strip(content, y, phoneStrip(res.tone === "red" ? "Not saved" : "Done", res.tone === "red" ? "red" : "green", "green"));
          y = this._card(content, y + 12, res.tone, res.icon, res.title, res.text, true);
          if (p.result && p.result.count > 0) main = { label: "Show in My files", name: "mainBtn", method: "showFiles", kind: "main", w: 142 };
        } else {
          // a problem: the phone is still there, so the strip stays as it was
          var pr = NS.PROBLEMS[(p.problem && p.problem.kind) || "refused"] || NS.PROBLEMS.refused;
          y = this._strip(content, y, phoneStrip("Connected", "green", "green"));
          y = this._card(content, y + 12, pr.tone, pr.icon, pr.title, pr.text, false);
        }
        y = this._foot(content, y + 14, main);

        var contentH = y + NS.PAD;
        this.setExtent(lively.pt(NS.W + 6, contentH + 28));
        content.setExtent(lively.pt(NS.W, contentH));
        this._keepOnScreen();
      },

      // ── the small pieces ──

      // A text. x, y, w, h are the box; o: pt (the size in points: px * 0.75), bold, color, mono, icon (a Material Symbols glyph), fill,
      // radius, line (a border colour), align, top (room above the text, to centre a glyph), input (a box a person can select in and
      // copy from), name, ignore (the text takes no clicks). None has padding of its own, so a text sits exactly where it is put.
      _t: function _t(parent, str, x, y, w, h, o) {
        o = o || {};
        var NS = lively.identity.PhoneDialog;
        var t = new lively.morphic.Text(lively.rect(x, y, w, h), str);
        t.applyStyle({
          allowInput: !!o.input,
          fontFamily: o.icon ? NS.ICONS : o.mono ? NS.MONO : NS.FONT,
          fontSize: o.pt || 9,
          fontWeight: o.bold ? "bold" : "normal",
          textColor: o.color || NS.C.text,
          padding: lively.rect(o.input ? 4 : 0, o.top || 0, 0, 0),
          fill: o.fill || (o.input ? Color.white : null),
          borderWidth: o.input || o.line ? 1 : 0,
          borderColor: o.input ? NS.C.line : (o.line || null),
          borderRadius: o.radius || (o.input ? 3.75 : 0),
          align: o.align || "left",
          fixedWidth: true,
          fixedHeight: true,
          clipMode: "hidden",
        });
        if (o.name) t.name = o.name;
        if (o.ignore) t.ignoreEvents();
        parent.addMorph(t);
        return t;
      },

      // A round icon on a soft background (a Material Symbols glyph; px is its size in pixels, the box is d across; fg: another colour
      // for the glyph than the tone's, given now because a colour changed after drawing can fail to reach the page).
      _dot: function _dot(parent, glyph, x, y, d, px, tone, name, fg) {
        var NS = lively.identity.PhoneDialog, T = NS.TONES[tone] || NS.TONES.grey;
        return this._t(parent, glyph, x, y, d, d, { icon: true, pt: px * 0.75, color: fg || T.fg, fill: T.bg, radius: d / 2, align: "center", top: Math.round((d - px) / 2), name: name, ignore: true });
      },

      // A box. o: fill, line (border colour), radius, dashed.
      _box: function _box(parent, x, y, w, h, o) {
        o = o || {};
        var b = new lively.morphic.Box(lively.rect(x, y, w, h));
        b.applyStyle({ fill: o.fill || null, borderWidth: o.line ? 1 : 0, borderColor: o.line || null, borderRadius: o.radius || 0 });
        if (o.dashed) b.setBorderStyle("dashed");
        if (o.name) b.name = o.name;
        b.ignoreEvents();
        parent.addMorph(b);
        return b;
      },

      // see LoginDialog: applyStyle alone does not reach the DOM for a button made in code. kind: "main" (green, white words) or "plain".
      _btn: function _btn(parent, str, name, x, y, bw, kind, method, argField, argValue) {
        var NS = lively.identity.PhoneDialog, self = this;
        var b = new lively.morphic.Button(lively.rect(x, y, bw, 24), str);
        b.name = name;
        if (argField) b[argField] = argValue;
        parent.addMorph(b);
        var main = kind === "main", line = main ? "rgb(47,158,91)" : "rgb(214,214,214)", fill = main ? "rgb(47,158,91)" : null;
        b.applyStyle({ borderColor: line, borderWidth: 1, borderRadius: 5, fill: fill });
        if (main && b.label) { b.label.setTextColor(Color.white); b.label.applyStyle({ fontWeight: "bold" }); }
        (function () {
          var node = b.renderContext && b.renderContext().shapeNode;
          if (node) { node.style.borderColor = line; node.style.borderWidth = "1px"; node.style.borderRadius = "5px"; node.style.background = fill || ""; }
          var ln = main && b.label && b.label.renderContext && b.label.renderContext().shapeNode;
          if (ln) { ln.style.color = "#fff"; ln.style.fontWeight = "bold"; Array.prototype.forEach.call(ln.querySelectorAll("*"), function (c) { c.style.color = "#fff"; c.style.fontWeight = "bold"; }); }
        }).delay(0);
        if (argField) {
          // a converter is rebuilt from its source text and loses its closure: the field name has to be written out
          lively.bindings.connect(b, "fire", self, method, { converter: function () { return this.sourceObj.addressIx; } });
        } else {
          lively.bindings.connect(b, "fire", self, method);
        }
        return b;
      },

      // One paragraph on its own (nothing is running, or nobody is signed in). Returns where the next thing starts.
      _note: function _note(content, y, str, named) {
        var NS = lively.identity.PhoneDialog, n = NS.lineCount(str, 12, NS.INNER);
        this._t(content, str, NS.PAD, y, NS.INNER, n * NS.LINE + 4, { name: named ? "noteText" : null });
        return y + n * NS.LINE + 4;
      },

      // The top strip, about the phone: a circle with the phone in it, who (or that nobody yet), one grey line and a state word.
      _strip: function _strip(content, y, s) {
        var NS = lively.identity.PhoneDialog, T = NS.TONES[s.tone] || NS.TONES.grey;
        var chipW = Math.round(NS.textW("●  " + s.chip, 11, true)) + 20, left = 64, right = 10;
        var box = this._box(content, NS.PAD, y, NS.INNER, 64, { fill: Color.white, line: NS.C.line, radius: 7, name: "strip" });
        this._dot(box, "smartphone", 10, 9, 44, 24, s.av || "grey", "stripIcon", !s.av || s.av === "grey" ? NS.C.faint : null);
        var textW = NS.INNER - 2 - left - right - chipW - 8;
        this._t(box, s.name, left, 11, textW, 20, { pt: 9.75, bold: true, color: NS.C.strong, name: "stripName", ignore: true });
        this._t(box, s.line, left, 31, textW, 18, { pt: 8.25, color: NS.C.muted, name: "stripLine", ignore: true });
        this._t(box, "●  " + s.chip, NS.INNER - 2 - right - chipW, 20, chipW, 22, { pt: 8.25, bold: true, color: T.fg, fill: T.bg, radius: 11, align: "center", top: 4, name: "stripChip", ignore: true });
        return y + 64;
      },

      // An icon in a circle, a bold headline and a few short sentences beside it. big: the larger headline of a result.
      _card: function _card(content, y, tone, glyph, title, text, big) {
        var NS = lively.identity.PhoneDialog, x = NS.PAD + 36 + 10, w = NS.PAD + NS.INNER - x;
        this._dot(content, glyph, NS.PAD, y, 36, 22, tone, "cardIcon");
        var tpx = big ? 15 : 13, th = big ? 22 : 20;
        this._t(content, title, x, y, w, th, { pt: tpx * 0.75, bold: true, color: NS.C.strong, name: "cardTitle", ignore: true });
        var n = text ? NS.lineCount(text, 12, w) : 0, h = n * NS.LINE + 4;
        if (text) this._t(content, text, x, y + th, w, h, { color: NS.C.text, name: "cardText", ignore: true });
        return y + Math.max(36, th + (text ? h : 0));
      },

      // "Waiting for the phone to choose files": a dashed box.
      _waitBox: function _waitBox(content, y, title, text) {
        var NS = lively.identity.PhoneDialog, h = 98;
        var box = this._box(content, NS.PAD, y, NS.INNER, h, { fill: Color.white, line: NS.C.line, radius: 7, dashed: true, name: "waitBox" });
        this._t(box, "upload_file", 0, 12, NS.INNER - 2, 32, { icon: true, pt: 22.5, color: Color.rgb(154, 154, 154), align: "center", name: "waitIcon", ignore: true });
        this._t(box, title, 0, 46, NS.INNER - 2, 20, { pt: 9.75, bold: true, color: NS.C.strong, align: "center", name: "cardTitle", ignore: true });
        this._t(box, text, 0, 66, NS.INNER - 2, 20, { color: NS.C.text, align: "center", name: "cardText", ignore: true });
        return y + h;
      },

      // The code beside the steps, the address with Copy, which network, and what to check when nothing has come for a while.
      _waiting: function _waiting(content, y) {
        var self = this, NS = lively.identity.PhoneDialog, p = this._p, QR = 176, y0 = y;
        var img = new lively.morphic.Image(lively.rect(NS.PAD, y, QR, QR));
        img.name = "phoneQr";
        img.applyStyle({ borderWidth: 1, borderColor: NS.C.line, borderRadius: 3, fill: Color.white, clipMode: "hidden" });
        img.setImageURL(p.qrs[p.ix] || p.qrs[0]);
        img.ignoreEvents();
        content.addMorph(img);
        var sx = NS.PAD + QR + 16, sw = NS.PAD + NS.INNER - sx, sy = y;
        this._t(content, "wifi", sx, sy, 22, 22, { icon: true, pt: 13.5, color: NS.TONES.green.fg, top: 0, name: "sameIcon", ignore: true });
        var same = "Phone and webputer on the same Wi-Fi", sn = NS.lineCount(same, 12, sw - 26, true);
        this._t(content, same, sx + 24, sy + 1, sw - 24, sn * NS.LINE + 2, { bold: true, color: NS.C.strong, name: "sameText", ignore: true });
        sy += Math.max(22, sn * NS.LINE + 2) + 10;
        var steps = ["Open the camera on your phone and point it at the code.", "Open the link the camera shows.", "Choose the files to send. This webputer asks you before it takes them."];
        steps.forEach(function (s, i) {
          var n = NS.lineCount(s, 12, sw - 26);
          self._t(content, String(i + 1), sx, sy, 18, 18, { pt: 8.25, bold: true, color: Color.rgb(85, 85, 85), fill: Color.rgb(228, 228, 228), radius: 9, align: "center", top: 1, name: "stepNo" + (i + 1), ignore: true });
          self._t(content, s, sx + 26, sy - 1, sw - 26, n * NS.LINE + 2, { name: "stepText" + (i + 1), ignore: true });
          sy += Math.max(18, n * NS.LINE) + 8;
        });
        y = y0 + QR + 12;
        // the address in a box a person can select and copy by hand (an editable Text, so the browser's own selection works)
        var copyW = 84;
        this._t(content, p.urls[p.ix] || p.urls[0], NS.PAD, y, NS.INNER - copyW - 8, 24, { input: true, mono: true, pt: 8.25, top: 4, name: "addressBox" });
        this._btn(content, "Copy", "copyBtn", NS.PAD + NS.INNER - copyW, y, copyW, "plain", "copyAddress");
        y += 24;
        if (p.urls.length > 1) {
          y += 10;
          var msg = "This webputer is on " + (p.urls.length === 2 ? "two networks" : p.urls.length + " networks") + ". If the phone cannot open the page, try " + (p.urls.length === 2 ? "the other one" : "another one") + ".";
          var mn = NS.lineCount(msg, 12, NS.INNER);
          this._t(content, msg, NS.PAD, y, NS.INNER, mn * NS.LINE + 2, { name: "netsText", ignore: true });
          y += mn * NS.LINE + 6;
          var bx = NS.PAD;
          p.urls.forEach(function (u, i) {
            var host = u.replace(/^http:\/\//, "").replace(/:.*$/, ""), bw = Math.round(NS.textW(host, 11, i === p.ix, true)) + 26;
            if (i === p.ix) self._t(content, host, bx, y, bw, 24, { mono: true, pt: 8.25, bold: true, color: NS.C.strong, fill: Color.rgb(243, 243, 243), line: NS.C.frame, radius: 5, align: "center", top: 4, name: "netOn", ignore: true });
            else self._btn(content, host, "altBtn" + i, bx, y, bw, "plain", "useAddress", "addressIx", i);
            bx += bw + 6;
          });
          y += 24;
        }
        if (p.hint) y = this._hint(content, y + 12);
        return y;
      },

      // After half a minute with nobody: the same advice as before, as a list.
      _hint: function _hint(content, y) {
        var NS = lively.identity.PhoneDialog, self = this;
        var items = ["The phone is on the same Wi-Fi as this webputer, not on mobile data.", "It is not a guest or public Wi-Fi: those often stop devices from seeing each other.",
          "If this webputer asked about a firewall, the answer was Yes for private networks.", "No VPN is on."];
        var tx = 36, tw = NS.INNER - 2 - tx - 10, h = 10 + 20 + 4;
        var counts = items.map(function (s) { return NS.lineCount(s, 12, tw - 14); });
        counts.forEach(function (n) { h += n * NS.LINE + 2; });
        h += 8;
        var box = this._box(content, NS.PAD, y, NS.INNER, h, { fill: NS.C.hintBg, line: NS.C.hintLine, radius: 7, name: "hint" });
        this._t(box, "help", 10, 9, 22, 22, { icon: true, pt: 13.5, color: NS.TONES.amber.fg, top: 0, name: "hintIcon", ignore: true });
        this._t(box, "Nothing has opened the page yet", tx, 10, tw, 20, { bold: true, color: NS.C.hintTitle, name: "hintTitle", ignore: true });
        var yy = 10 + 20 + 4;
        items.forEach(function (s, i) {
          self._t(box, "•", tx, yy, 12, NS.LINE, { color: NS.TONES.amber.fg, ignore: true });
          self._t(box, s, tx + 14, yy, tw - 14, counts[i] * NS.LINE + 2, { color: NS.TONES.amber.fg, name: "hintItem" + (i + 1), ignore: true });
          yy += counts[i] * NS.LINE + 2;
        });
        return y + h;
      },

      // The bar: how much of what the phone offered has arrived, in bytes, with speed and time left worked out here from the progress
      // events (so they are estimates, and say nothing until there are enough).
      _receiving: function _receiving(content, y) {
        var NS = lively.identity.PhoneDialog, rx = this._p.rx || { done: 0, total: 0, count: 0 }, w = NS.INNER;
        this._t(content, this._rxTitle(), NS.PAD, y, w - 90, 22, { pt: 9.75, bold: true, color: NS.C.strong, name: "progressTitle", ignore: true });
        this._t(content, this._rxPct(), NS.PAD + w - 90, y - 4, 90, 28, { pt: 15, bold: true, color: NS.C.strong, align: "right", name: "progressPercent", ignore: true });
        y += 28;
        this._box(content, NS.PAD, y, w, 12, { fill: NS.C.track, radius: 6, name: "progressTrack" });
        this._box(content, NS.PAD, y, Math.max(0, Math.round(w * this._rxFraction())), 12, { fill: NS.C.green, radius: 6, name: "progressFill" });
        y += 18;
        this._t(content, this._rxBytes(), NS.PAD, y, w * 0.5, 18, { pt: 8.25, color: NS.C.muted, name: "progressBytes", ignore: true });
        this._t(content, this._rxRate(), NS.PAD + w * 0.5, y, w * 0.5, 18, { pt: 8.25, color: NS.C.muted, align: "right", name: "progressRate", ignore: true });
        return y + 20;
      },

      // "Saving file 2 of 3": the files arrive complete and are then sealed and named one by one.
      _saving: function _saving(content, y) {
        var NS = lively.identity.PhoneDialog, s = this._p.saving || { index: 1, count: 1 }, w = NS.INNER;
        this._t(content, "Saving file " + s.index + " of " + s.count, NS.PAD, y, w, 22, { pt: 9.75, bold: true, color: NS.C.strong, name: "progressTitle", ignore: true });
        y += 28;
        this._box(content, NS.PAD, y, w, 12, { fill: NS.C.track, radius: 6, name: "progressTrack" });
        this._box(content, NS.PAD, y, Math.max(0, Math.round(w * Math.max(0, s.index - 1) / Math.max(1, s.count))), 12, { fill: NS.C.green, radius: 6, name: "progressFill" });
        return y + 14;
      },

      // The foot: a plain Close on the left (the same as PeerDialog), the main action, if there is one, on the right.
      _foot: function _foot(content, y, main) {
        var NS = lively.identity.PhoneDialog;
        this._btn(content, "Close", "closeBtn", NS.PAD, y, 80, "plain", "remove");
        if (main) this._btn(content, main.label, main.name, NS.PAD + NS.INNER - main.w, y, main.w, main.kind, main.method);
        return y + 24;
      },

      // The window is first drawn for its small size and then grows by the code: put it back where all of it can be seen (and again
      // after each redraw that changes its height), but never move a window the person has dragged.
      _keepOnScreen: function _keepOnScreen() {
        var h = this.getExtent().y, top = Math.max(40, Math.round((window.innerHeight - h) / 2)), pos = this.getPosition();
        // a window the person has moved since the last time it was placed here stays where they put it
        if (this._autoPos && (Math.abs(pos.x - this._autoPos.x) > 3 || Math.abs(pos.y - this._autoPos.y) > 3)) return;
        var want = top + (window.pageYOffset || 0);
        if (Math.abs(pos.y - want) > 2) this.setPosition(lively.pt(pos.x, want));
        this._autoPos = this.getPosition();
      },

      // ─── the bar's words ────────────────────────────────────────────────────────

      _rxTitle: function _rxTitle() {
        var rx = this._p.rx, n = rx && rx.count;
        return n ? "Receiving " + lively.identity.PhoneDialog.plural(n, "file", "files") : "Receiving";
      },
      _rxFraction: function _rxFraction() {
        var rx = this._p.rx;
        return rx && rx.total ? Math.max(0, Math.min(1, rx.done / rx.total)) : 0;
      },
      _rxPct: function _rxPct() { return Math.floor(this._rxFraction() * 100) + "%"; },
      _rxBytes: function _rxBytes() {
        var rx = this._p.rx;
        return rx && rx.total ? lively.identity.PhoneDialog.sizePair(rx.done, rx.total) : "";
      },
      // Nothing until there are two reports to tell it from.
      _rxRate: function _rxRate() {
        var NS = lively.identity.PhoneDialog, rx = this._p.rx, v = rx && NS.speedOf(rx.samples);
        if (!v) return "";
        return NS.sizeText(v) + "/s · " + NS.leftText((rx.total - rx.done) / v) + " left";
      },

      // The bar and its words only.
      updateProgress: function updateProgress() {
        var NS = lively.identity.PhoneDialog, fill = this.get("progressFill");
        if (!fill || this._p.step !== "receiving") return this.render();
        fill.setExtent(lively.pt(Math.max(0, Math.round(NS.INNER * this._rxFraction())), 12));
        var set = function (win, name, str) { var t = win.get(name); if (t && t.textString !== str) t.setTextString(str); };
        set(this, "progressTitle", this._rxTitle());
        set(this, "progressPercent", this._rxPct());
        set(this, "progressBytes", this._rxBytes());
        set(this, "progressRate", this._rxRate());
      },

      // ─── events from the shell ──────────────────────────────────────────────────

      // What the shell tells this window: that a phone opened the page, that its question is up, progress, saving, the result. Never a name.
      onPhoneEvent: function onPhoneEvent(ev) {
        var p = this._p, NS = lively.identity.PhoneDialog;
        if (!p || !this.world() || p.phase === "closed") return;
        var problem = function (win, kind) { p.step = "problem"; p.problem = { kind: kind }; p.rx = null; win.render(); };
        if (ev.type === "claimed") {
          p.claimed = true; p.hint = false; p.step = "connected"; p.problem = null;
          p.phone = { who: NS.capital(ev.who), ip: ev.ip };
          this.render();
        } else if (ev.type === "asked") {
          p.step = "asked"; p.ask = { count: ev.count, total: ev.total }; p.rx = null; p.problem = null;
          this.render();
        } else if (ev.type === "answered") {
          if (!ev.accepted) return problem(this, "declined");
          p.step = "receiving"; p.problem = null;
          p.rx = { done: 0, total: p.ask ? p.ask.total : 0, count: p.ask ? p.ask.count : 0, samples: [] };
          this.render();
        } else if (ev.type === "progress") {
          // One batch is received and saved at the same time (each file is saved as soon as it is whole), so a report can come after a
          // file has begun to be saved. Only the screens that are before the bar, or the bar itself, take a report.
          if (p.step === "saving" || p.step === "done" || p.step === "problem") return;
          var rx = p.rx || (p.rx = { done: 0, total: 0, count: p.ask ? p.ask.count : 0, samples: [] });
          rx.done = ev.done; rx.total = ev.total || rx.total;
          var now = Date.now();
          rx.samples.push({ t: now, done: ev.done });
          while (rx.samples.length > 2 && now - rx.samples[0].t > 5000) rx.samples.shift();
          if (p.step !== "receiving") { p.step = "receiving"; this.render(); } else this.updateProgress();
        } else if (ev.type === "saving") {
          // While files are still coming in (and this is not the last one), the bar is still what matters.
          p.saving = { index: ev.index, count: ev.count };
          if (p.step === "receiving" && p.rx && p.rx.done < p.rx.total && ev.index < ev.count) return;
          p.step = "saving"; p.rx = null;
          this.render();
        } else if (ev.type === "saved") {
          p.step = "done"; p.result = { count: ev.count, existed: ev.existed, failed: ev.failed, folder: ev.folder }; p.rx = null; p.saving = null;
          // My files, if it is open, shows what arrived (it listens for this page event, as it does for a file added by a drop)
          try { window.dispatchEvent(new CustomEvent("keo-files-changed")); } catch (e) { /* no page events here */ }
          this.render();
        } else if (ev.type === "cancelled") {
          // by: the phone, it went away (gone), nobody answered in time (timeout) or this computer; none is said when the shell does not know
          problem(this, ev.by === "timeout" ? "timeout" : "cancelled");
        } else if (ev.type === "refused") {
          problem(this, ev.reason === "space" ? "space" : "refused");
        } else if (ev.type === "error") {
          // a file that could not be SAVED is counted in the result at the end, and must not replace what is on the screen
          if (ev.kind === "save") return;
          problem(this, ev.kind === "app" ? "app" : "failed");
        } else if (ev.type === "expired") {
          p.phase = "expired"; p.hint = false; p.rx = null;
          this.render();
        } else if (ev.type === "closed") {
          // the session ended (signed out) while the window was open: nothing is listening any more
          p.phase = "signedout"; p.rx = null;
          this.render();
        }
      },
    });
  }); // end module('lively.identity.PhoneDialog')
