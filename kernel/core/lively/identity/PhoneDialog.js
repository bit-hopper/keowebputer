/**
 * lively.identity.PhoneDialog
 *
 * Window for receiving files from a phone over the local network ("Connect a phone"). Inside the desktop app only: the app runs a small
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
 * The look follows PeerDialog (Connect a device): the same window, the same fonts and sizes, the same plain buttons.
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
      titleBar: "Connect a phone",
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
        this._p = { phase: "starting", urls: [], qrs: [], ix: 0, claimed: false, state: "", error: null, progress: null, hint: false };
        // Events are not queued by the shell: this window listens from the start (and asks for the state at hand once it is running).
        this._stopListening = lively.identity.localIdentity.onPhoneEvent(function (ev) { self.onPhoneEvent(ev); });
        this.render();
        this.begin();
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

      // Starts the server through the shell and shows the code. The shell answers for a server that is already running too.
      begin: function begin() {
        var self = this, p = this._p;
        lively.identity.localIdentity.phoneStart(function (err, r) {
          if (!self.world()) { if (!err) lively.identity.localIdentity.phoneStop(); return; }
          if (err) { p.phase = "error"; p.error = err.message || String(err); return self.render(); }
          p.phase = "running"; p.urls = r.urls || []; p.qrs = r.qrs || []; p.ix = 0;
          p.claimed = !!r.claimed;
          self._autoPos = null;   // the first full drawing places the window afresh: it was centred for its small first size
          if (r.claimed && r.phone) p.state = "A phone opened the page (" + r.phone.who + " at " + r.phone.ip + "). Choose files on the phone.";
          else p.state = p.urls.length ? "Waiting for a phone …" : "";
          self.render();
          if (!p.claimed) {
            self._hintTimer = setTimeout(function () {
              if (self.world() && !self._p.claimed && self._p.phase === "running") { self._p.hint = true; self.render(); }
            }, 30000);
          }
        });
      },

      // ─── drawing ────────────────────────────────────────────────────────────────

      // The whole content is drawn again for each change of what is shown; a progress update only moves the bar and its words
      // (updateProgress). The window is sized to its content: the window's extent is set first, because its layout stretches the
      // content by the change of its height, and the content's extent last (the same as PeerDialog).
      render: function render() {
        var self = this, content = this.get("phoneContent"), p = this._p;
        if (!content) return;
        content.removeAllMorphs();
        var pad = 14, W = 474, w = W - pad * 2, y = pad;

        function text(str, h, opts) {
          opts = opts || {};
          var t = new lively.morphic.Text(lively.rect(opts.x === undefined ? pad : opts.x, y, opts.w || w, h), str);
          t.applyStyle({
            allowInput: !!opts.input,
            fontFamily: opts.mono ? "Menlo, Consolas, monospace" : "Arial, sans-serif",
            fontSize: opts.size || 9,   // points: 9 is about 12 px
            fontWeight: opts.bold ? "bold" : "normal",
            textColor: opts.color || Color.rgb(70, 70, 70),
            padding: lively.rect(4, 3, 0, 0),
            fill: opts.input ? Color.white : null,
            borderWidth: opts.input ? 1 : 0,
            borderColor: opts.input ? Color.rgb(203, 203, 203) : null,
            borderRadius: opts.input ? 3.75 : 0,
            fixedWidth: true,
            fixedHeight: true,
            clipMode: "hidden",
          });
          if (opts.name) t.name = opts.name;
          content.addMorph(t);
          return t;
        }
        function label(str, h, opts) { var t = text(str, h || 20, opts); y += (h || 20) + 4; return t; }
        function paintButton(btn, borderColor, borderWidth, borderRadius, fill) {
          // see LoginDialog: applyStyle alone does not reach the DOM for a button made in code
          btn.applyStyle({ borderColor: borderColor, borderWidth: borderWidth, borderRadius: borderRadius, fill: fill });
          (function () {
            var node = btn.renderContext && btn.renderContext().shapeNode;
            if (node) {
              node.style.borderColor = borderColor;
              node.style.borderWidth = borderWidth + "px";
              node.style.borderRadius = borderRadius + "px";
              node.style.background = fill || "";
            }
          }).delay(0);
        }
        function button(str, name, x, bw, method, argField, argValue, yy) {
          var b = new lively.morphic.Button(lively.rect(x, yy === undefined ? y : yy, bw, 24), str);
          b.name = name;
          if (argField) b[argField] = argValue;
          content.addMorph(b);
          paintButton(b, "rgb(214,214,214)", 1, 5, null);
          if (argField) {
            // a converter is rebuilt from its source text and loses its closure: the field name has to be written out
            lively.bindings.connect(b, "fire", self, method, { converter: function () { return this.sourceObj.addressIx; } });
          } else {
            lively.bindings.connect(b, "fire", self, method);
          }
          return b;
        }

        var local = lively.identity.localIdentity;
        if (!local.isAvailable()) {
          label("Connecting a phone needs keo webputer.");
        } else if (p.phase === "starting") {
          label("Starting …");
        } else if (p.phase === "error") {
          label(p.error || "Could not start.", 40, { color: Color.rgb(204, 51, 51) });
        } else {
          if (!p.urls.length) {
            label("This computer has no network address a phone could reach. Is it connected to Wi-Fi or a cable? Connect it, then close this window and open it again.", 56, { color: Color.rgb(204, 51, 51) });
          } else if (!p.claimed && p.phase === "running") {
            label("On your phone, open the camera (or a code reader) and point it at this code. The phone and this computer must be on the same Wi-Fi. Then choose the files to send.", 48);
            var QR = 176;
            var img = new lively.morphic.Image(lively.rect(Math.round((W - QR) / 2), y, QR, QR));
            img.name = "phoneQr";
            img.applyStyle({ borderWidth: 1, borderColor: Color.rgb(203, 203, 203), borderRadius: 3, fill: Color.white, clipMode: "hidden" });
            img.setImageURL(p.qrs[p.ix] || p.qrs[0]);
            img.ignoreEvents();
            content.addMorph(img);
            y += QR + 8;
            // the address in a box a person can select and copy by hand (an editable Text, so the browser's own selection works)
            text(p.urls[p.ix] || p.urls[0], 24, { input: true, mono: true, size: 8, name: "addressBox" });
            y += 30;
            if (p.urls.length > 1) {
              label("This computer is on more than one network. If the phone cannot open the page, try another address:", 34);
              var bx = pad;
              p.urls.forEach(function (u, i) {
                if (i === p.ix) return;
                var host = u.replace(/^http:\/\//, "").replace(/:.*$/, "");
                var b = button(host, "altBtn" + i, bx, 110, "useAddress", "addressIx", i);
                bx += 118;
              });
              y += 32;
            }
          }
          if (p.state) label(p.state, 38, { name: "stateText", color: p.stateBad ? Color.rgb(204, 51, 51) : Color.rgb(70, 70, 70), bold: true });
          if (p.progress !== null) {
            var track = new lively.morphic.Box(lively.rect(pad, y, w, 6));
            track.name = "progressTrack"; track.setFill(Color.rgb(224, 224, 224)); track.applyStyle({ borderRadius: 3, borderWidth: 0 }); track.ignoreEvents();
            content.addMorph(track);
            var fill = new lively.morphic.Box(lively.rect(pad, y, Math.max(0, Math.round(w * p.progress)), 6));
            fill.name = "progressFill"; fill.setFill(Color.rgb(47, 158, 91)); fill.applyStyle({ borderRadius: 3, borderWidth: 0 }); fill.ignoreEvents();
            content.addMorph(fill);
            y += 16;
          }
          if (p.hint) {
            label("Nothing has opened the page yet. Check that the phone is on the same Wi-Fi as this computer (not mobile data, not a guest network), that a firewall question on this computer was answered Yes for private networks, and that no VPN is on. Some public or guest Wi-Fi stops devices from seeing each other; then this cannot work on that network.", 92, { color: Color.rgb(160, 110, 20) });
          }
        }
        var closeBtn = button("Close", "closeBtn", pad, 80, "remove");
        y += 32;

        var contentH = y + pad;
        this.setExtent(lively.pt(W + 6, contentH + 28));
        content.setExtent(lively.pt(W, contentH));
        this._keepOnScreen();
      },

      // The window opens centred for its small first size and then grows by the code: put it back where all of it can be seen (and again
      // after each redraw that changes its height), but never move a window the person has dragged.
      _keepOnScreen: function _keepOnScreen() {
        var h = this.getExtent().y, top = Math.max(40, Math.round((window.innerHeight - h) / 2)), pos = this.getPosition();
        // a window the person has moved since the last time it was placed here stays where they put it
        if (this._autoPos && (Math.abs(pos.x - this._autoPos.x) > 3 || Math.abs(pos.y - this._autoPos.y) > 3)) return;
        var want = top + (window.pageYOffset || 0);
        if (Math.abs(pos.y - want) > 2) this.setPosition(lively.pt(pos.x, want));
        this._autoPos = this.getPosition();
      },

      useAddress: function useAddress(i) { this._p.ix = i; this.render(); },

      // The bar and its words only.
      updateProgress: function updateProgress() {
        var content = this.get("phoneContent"), p = this._p;
        if (!content || p.progress === null) return;
        var fill = this.get("progressFill");
        if (!fill) return this.render();
        fill.setExtent(lively.pt(Math.max(0, Math.round((474 - 28) * p.progress)), 6));
        var t = this.get("stateText");
        if (t) t.setTextString(p.state);
      },

      // ─── events from the shell ──────────────────────────────────────────────────

      // What the shell tells this window: that a phone opened the page, that its question is up, progress, saving, the result. Never a name.
      onPhoneEvent: function onPhoneEvent(ev) {
        var p = this._p;
        if (!p || !this.world() || p.phase === "closed") return;
        var plural = function (n, one, many) { return n + " " + (n === 1 ? one : many); };
        if (ev.type === "claimed") {
          p.claimed = true; p.hint = false; p.stateBad = false;
          p.state = "A phone opened the page (" + ev.who + " at " + ev.ip + "). Choose files on the phone.";
          this.render();
        } else if (ev.type === "asked") {
          p.stateBad = false; p.progress = null;
          p.state = "A question is on screen: " + plural(ev.count, "file", "files") + " are waiting for your answer. Nothing is taken until you accept.";
          this.render();
        } else if (ev.type === "answered") {
          p.stateBad = false;
          p.state = ev.accepted ? "Receiving …" : "Declined. The phone was told.";
          p.progress = ev.accepted ? 0 : null;
          this.render();
        } else if (ev.type === "progress") {
          p.progress = ev.total ? Math.min(1, ev.done / ev.total) : 1;
          p.state = "Receiving: " + Math.floor(p.progress * 100) + "%";
          this.updateProgress();
        } else if (ev.type === "saving") {
          p.state = "Saving file " + ev.index + " of " + ev.count + " …";
          p.stateBad = false;
          this.render();
        } else if (ev.type === "saved") {
          var parts = [];
          if (ev.count) parts.push(plural(ev.count, "file", "files") + " saved in the " + ev.folder + " folder of My files");
          if (ev.existed) parts.push(plural(ev.existed, "file was", "files were") + " already in your files");
          if (ev.failed) parts.push(plural(ev.failed, "file", "files") + " not saved");
          p.state = parts.join("; ") + ".";
          p.stateBad = !!ev.failed && !ev.count && !ev.existed;
          p.progress = null;
          // My files, if it is open, shows what arrived (it listens for this page event, as it does for a file added by a drop)
          try { window.dispatchEvent(new CustomEvent("keo-files-changed")); } catch (e) { /* no page events here */ }
          this.render();
        } else if (ev.type === "cancelled") {
          p.state = "The phone cancelled. Files already saved stay in the Dropped folder."; p.stateBad = false; p.progress = null;
          this.render();
        } else if (ev.type === "refused") {
          p.state = ev.reason === "space" ? "The phone tried to send more than this computer has room for. It was told no." : "A request was refused.";
          p.stateBad = true;
          this.render();
        } else if (ev.type === "error") {
          p.state = ev.message || "Something went wrong."; p.stateBad = true; p.progress = null;
          this.render();
        } else if (ev.type === "expired") {
          p.phase = "expired"; p.claimed = true; p.hint = false; p.progress = null; p.stateBad = true;
          p.state = "The code ran out because nobody used it. Close this window and open it again for a new one.";
          this.render();
        } else if (ev.type === "closed") {
          // the session ended (signed out) while the window was open: nothing is listening any more
          p.phase = "expired"; p.claimed = true; p.progress = null; p.stateBad = true;
          p.state = "Stopped: you were signed out.";
          this.render();
        }
      },
    });
  }); // end module('lively.identity.PhoneDialog')
