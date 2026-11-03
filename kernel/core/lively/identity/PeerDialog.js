/**
 * lively.identity.PeerDialog
 *
 * Window dialog for connecting to another device, directly, and sharing files with it. Inside keo only: it needs the
 * shell (lively.identity.localIdentity.isAvailable()), which holds the connection. There is no server and no handle.
 *
 * How two devices meet: one makes an INVITATION (a short text), sends it to the other by any means (a message, a paste, later a
 * QR), the other pastes it and gets an ANSWER, which goes back the same way and is pasted into the first. The devices then
 * connect straight to each other, so they need a direct network path (the same network). The codes name nobody: as soon as the
 * channel opens each side proves which identity it is, and the dialog then shows the other side's identicon, the name it chose
 * to show and its short DID. A person has to compare that with who they expect; a valid proof says which identity is there,
 * not that it is the one you meant.
 *
 * "Show as" is what this side tells the other. It starts as the identity's label, in plain view, and can be changed or emptied:
 * the label itself never leaves the device unless it is left in this field.
 *
 * A file moves only after the receiving person says yes. A received file is kept by the shell, not by the world; Save hands it
 * to the browser's download. Closing the window disconnects (a connection with no window could not be seen or stopped).
 *
 * The phases (this._p.phase): "start" (choose), "enter" (paste an invitation), "invited" (waiting for the answer),
 * "answered" (the answer is shown; waiting for the other side), "connected", "closed". Events from the shell come in through
 * onPeerEvent and only for this window's connection.
 *
 * Async convention: thenDo(err, result) throughout.
 *
 * Dependencies:
 *   lively.identity.LocalIdentity — the shell calls
 *   lively.identity.PostCardUtils — identiconDataUrl
 */

module("lively.identity.PeerDialog")
  .requires(
    "lively.identity.LocalIdentity",
    "lively.identity.PostCardUtils",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {
    lively.BuildSpec("lively.identity.PeerDialog", {
      _BorderRadius: 7,
      _Extent: lively.pt(480, 200),
      _Fill: Color.rgb(255, 16, 144),
      // Above every other morph (see LoginDialog): a world may give its own morphs an explicit z-index.
      _ZIndex: 1000,
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "IdentityPeerDialog",
      titleBar: "Connect a device",
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
          name: "peerContent",
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
        this._p = { phase: "start", name: "", id: null, code: null, peer: null, why: null };
        this._rows = [];
        // Events are not queued by the shell: this window listens from the start and only for its own connection.
        this._stopListening = lively.identity.localIdentity.onPeerEvent(function (ev) { self.onPeerEvent(ev); });
        // The name offered to the other side starts as the identity's label, visibly, and is the person's to change.
        lively.identity.localIdentity.session(function (err, s) {
          if (err || !s || !self.world()) return;
          if (self._p.phase === "start" && !self._p.nameTouched) {
            self._p.name = s.label || "";
            var inp = self.get("nameInput");
            if (inp) inp.setTextString(self._p.name);
          }
          self._p.defaultName = s.label || "";
        });
        this.render();
      },

      // Closing the window ends the connection: without a window nobody could see it or stop it.
      remove: function remove() {
        if (this._stopListening) { this._stopListening(); this._stopListening = null; }
        if (this._p && this._p.id && this._p.phase !== "closed") lively.identity.localIdentity.peerClose(this._p.id);
        if (this._p) this._p.id = null;
        $super();
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

      // ─── drawing ────────────────────────────────────────────────────────────────

      // The whole content is drawn again for each phase (and when a file row changes state); a progress update only changes the
      // text of its row (updateRow). The window is sized to its content: the window's extent is set first, because its layout
      // stretches the content by the change of its height, and the content's extent last.
      render: function render() {
        var self = this, content = this.get("peerContent"), p = this._p;
        if (!content) return;
        content.removeAllMorphs();
        var pad = 14, W = 474, w = W - pad * 2, y = pad;

        function text(str, h, opts) {
          opts = opts || {};
          var t = new lively.morphic.Text(lively.rect(pad, y, opts.w || w, h), str);
          t.applyStyle({
            allowInput: !!opts.input,
            fontFamily: opts.mono ? "Menlo, Consolas, monospace" : "Arial, sans-serif",
            fontSize: opts.size || 9,   // points: 9 is about 12 px
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
        function label(str, h) { var t = text(str, h || 20); y += (h || 20) + 4; return t; }
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
        // kind: "main" (pink) or "plain". x, w: where it sits in the row.
        function button(str, name, x, bw, kind, method, argField, argValue, yy) {
          var b = new lively.morphic.Button(lively.rect(x, yy === undefined ? y : yy, bw, 24), str);
          b.name = name;
          if (argField) b[argField] = argValue;
          content.addMorph(b);
          if (kind === "main") paintButton(b, "rgb(240,190,210)", 1.184, 5.2, "rgb(255,240,247)");
          else paintButton(b, "rgb(214,214,214)", 1, 5, null);
          if (argField) {
            // a converter is rebuilt from its source text and loses its closure: the field name has to be written out
            lively.bindings.connect(b, "fire", self, method, { converter: function () { return this.sourceObj.rowKey; } });
          } else {
            lively.bindings.connect(b, "fire", self, method);
          }
          return b;
        }
        // The code in a box a person can select and copy by hand (an editable Text, so the browser's own selection works).
        // Displayed in short lines: whitespace is ignored when a code is read back.
        function codeBox(code, name) {
          var shown = String(code).replace(/(.{46})/g, "$1\n").replace(/\n$/, "");
          text(shown, 62, { input: true, mono: true, size: 9, name: name });
          y += 68;
        }

        var local = lively.identity.localIdentity;
        if (!local.isAvailable()) {
          label("Connecting devices needs keo webputer.");
        } else if (p.phase === "start") {
          label("Connect to another device on this network. No server is involved.");
          label("Show as (optional), what the other device sees of you:");
          var nameInput = text(p.name || "", 24, { input: true, size: 10, name: "nameInput" });
          nameInput.beInputLine();
          y += 34;
          button("Make an invitation", "makeInvitationBtn", pad, 170, "main", "makeInvitation");
          button("I have an invitation", "haveInvitationBtn", pad + w - 170, 170, "plain", "showEnter");
          y += 32;
        } else if (p.phase === "enter") {
          label("Paste the invitation you were sent:");
          text("", 62, { input: true, mono: true, size: 9, name: "pasteBox" });
          y += 68;
          button("Answer", "answerBtn", pad + w - 100, 100, "main", "answerInvitation");
          button("Back", "backBtn", pad, 80, "plain", "startOver");
          y += 32;
        } else if (p.phase === "invited") {
          label("1. Send this invitation to the other device:");
          codeBox(p.code, "codeBox");
          button("Copy", "copyCodeBtn", pad, 80, "plain", "copyCode");
          y += 32;
          label("2. Paste its answer here:");
          text("", 62, { input: true, mono: true, size: 9, name: "pasteBox" });
          y += 68;
          button("Connect", "connectBtn", pad + w - 100, 100, "main", "finishConnect");
          button("Cancel", "cancelBtn", pad, 80, "plain", "startOver");
          y += 32;
        } else if (p.phase === "answered") {
          label("Send this answer back to the first device:");
          codeBox(p.code, "codeBox");
          button("Copy", "copyCodeBtn", pad, 80, "plain", "copyCode");
          y += 32;
          label("Waiting for the first device to take it…");
          button("Cancel", "cancelBtn", pad, 80, "plain", "startOver");
          y += 32;
        } else if (p.phase === "connected") {
          this._drawPeer(content, pad, y, w);
          y += 58;
          label("This device proved it holds this identity. Check that it is who you expect.", 36);
          this._rows.slice(-6).forEach(function (row) {
            var t = text(self.rowText(row), 22, { name: "transferLabel", w: w - 150 });
            t.rowKey = row.key;
            var bx = pad + w;
            function add(str, name, method, kind) { bx -= 70; var b = button(str, name, bx, 66, kind || "plain", method, "rowKey", row.key, y - 2); return b; }
            if (row.dir === "in" && row.state === "asked") { add("Decline", "declineBtn", "onDecline"); add("Accept", "acceptBtn", "onAccept", "main"); }
            else if (row.dir === "in" && row.state === "received") add("Save", "saveBtn", "onSave", "main");
            else if ((row.dir === "in" && row.state === "receiving") || (row.dir === "out" && (row.state === "offered" || row.state === "sending"))) add("Stop", "stopBtn", "onStop");
            y += 28;
          });
          if (this._rows.length > 6) { label("(" + (this._rows.length - 6) + " earlier transfers not shown)"); }
          y += 4;
          button("Send a file…", "sendFileBtn", pad, 120, "main", "chooseFiles");
          button("Disconnect", "disconnectBtn", pad + w - 100, 100, "plain", "startOver");
          y += 32;
        } else if (p.phase === "closed") {
          label("Disconnected." + (p.why ? " " + p.why : ""), 48);
          button("Start over", "startOverBtn", pad, 100, "main", "startOver");
          y += 32;
        }

        // room for two lines: an error can wrap
        var status = text("", 2 * 16 + 6, { name: "statusText" });
        y += 2 * 16 + 10;
        var closeBtn = button("Close", "closeBtn", pad, 80, "plain", "remove");

        var contentH = y + 24 + pad;
        this.setExtent(lively.pt(W + 6, contentH + 28));
        content.setExtent(lively.pt(W, contentH));
        if (p.status) this.setStatus(p.status.msg, p.status.isError);
      },

      // The other side: its identicon, the name it chose to show (or that it showed none), its short DID, a way to copy the DID.
      _drawPeer: function _drawPeer(content, pad, y, w) {
        var self = this, peer = this._p.peer || {}, local = lively.identity.localIdentity, AV = 44;
        var av = new lively.morphic.Image(lively.rect(pad, y, AV, AV));
        av.name = "peerAvatar";
        av.applyStyle({ borderRadius: AV / 2, borderWidth: 0, clipMode: "hidden" });
        av.setImageURL(lively.identity.postCardUtils.identiconDataUrl(peer.did, AV));
        av.ignoreEvents();
        content.addMorph(av);
        function line(str, name, yy, size, bold) {
          var t = new lively.morphic.Text(lively.rect(pad + AV + 8, yy, w - AV - 8 - 100, 20), str);
          t.applyStyle({ allowInput: false, fontFamily: "Arial, sans-serif", fontSize: size, fontWeight: bold ? "bold" : "normal",
            textColor: Color.rgb(50, 50, 50), padding: lively.rect(4, 2, 0, 0), fill: null, borderWidth: 0, borderColor: null,
            fixedWidth: true, fixedHeight: true, clipMode: "hidden" });
          t.name = name;
          content.addMorph(t);
        }
        line(peer.name ? peer.name : "(showed no name)", "peerName", y, 13, true);
        line(local.shortDid(peer.did), "peerDid", y + 22, 11, false);
        var b = new lively.morphic.Button(lively.rect(pad + w - 90, y + 10, 90, 24), "Copy DID");
        b.name = "copyDidBtn";
        content.addMorph(b);
        b.applyStyle({ borderColor: "rgb(214,214,214)", borderWidth: 1, borderRadius: 5, fill: null });
        (function () {
          var node = b.renderContext && b.renderContext().shapeNode;
          if (node) { node.style.borderColor = "rgb(214,214,214)"; node.style.borderWidth = "1px"; node.style.borderRadius = "5px"; node.style.background = ""; }
        }).delay(0);
        lively.bindings.connect(b, "fire", self, "copyPeerDid");
      },

      // ─── file rows ──────────────────────────────────────────────────────────────

      fmtSize: function fmtSize(n) {
        if (n < 1024) return n + " B";
        if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
        if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB";
        return (n / 1073741824).toFixed(2) + " GB";
      },

      rowText: function rowText(row) {
        var arrow = row.dir === "in" ? "↓ " : "↑ ", s = arrow + row.name + "  (" + this.fmtSize(row.size) + ")";
        var pct = row.size ? Math.min(100, Math.floor((row.done || 0) * 100 / row.size)) : 100;
        var tail = {
          asked: "wants to send you this",
          receiving: "receiving " + pct + "%",
          received: "received",
          saved: "saved",
          offered: "waiting for them to accept",
          sending: "sending " + pct + "%",
          awaiting: "sent, waiting for it to arrive",
          delivered: "delivered",
          declined: "they declined",
          cancelled: "stopped",
          failed: "failed" + (row.why ? ": " + row.why : ""),
        }[row.state] || row.state;
        return s + " — " + tail;
      },

      _row: function _row(dir, fid, create) {
        var key = dir + fid, found = null;
        this._rows.forEach(function (r) { if (r.key === key) found = r; });
        if (!found && create) { found = { key: key, dir: dir, fid: fid, name: create.name || "file", size: create.size || 0, state: create.state, done: 0 }; this._rows.push(found); }
        return found;
      },

      // Progress changes the text of one row, not the whole picture.
      updateRow: function updateRow(row) {
        var self = this, content = this.get("peerContent");
        if (!content) return;
        content.submorphs.forEach(function (m) { if (m.name === "transferLabel" && m.rowKey === row.key) m.setTextString(self.rowText(row)); });
      },

      // ─── events from the shell ──────────────────────────────────────────────────

      onPeerEvent: function onPeerEvent(ev) {
        var p = this._p;
        if (!p || !this.world() || !p.id || ev.id !== p.id) return;
        var row;
        if (ev.type === "state") {
          if (ev.state === "ready") { p.phase = "connected"; p.peer = ev.peer; p.status = null; this.render(); }
          else if (ev.state === "closed") {
            if (p.phase === "closed") return;
            p.phase = "closed"; p.why = ev.why || ""; p.id = null; p.status = null; this.render();
          } else if (ev.state === "connecting" || ev.state === "open") {
            this.setStatus(ev.state === "open" ? "Connected. Checking who it is…" : "Connecting…");
          }
        } else if (ev.type === "incoming") {
          this._row("in", ev.fid, { name: ev.name, size: ev.size, state: "asked" });
          this.render();
        } else if (ev.type === "progress") {
          row = this._row(ev.dir, ev.fid, { name: ev.name, size: ev.total, state: ev.dir === "in" ? "receiving" : "sending" });
          row.done = ev.done;
          if (row.dir === "out" && row.state === "offered") row.state = "sending";
          if (row.dir === "out" && ev.done >= ev.total) row.state = "awaiting";
          this.updateRow(row);
        } else if (ev.type === "received" || ev.type === "saved" || ev.type === "delivered" || ev.type === "declined" || ev.type === "cancelled" || ev.type === "failed") {
          row = this._row(ev.dir, ev.fid, { name: ev.name, size: ev.size, state: ev.type });
          row.state = ev.type;
          if (ev.type === "received" || ev.type === "delivered") row.done = row.size;
          if (ev.why) row.why = ev.why;
          this.render();
        }
      },

      // ─── actions ────────────────────────────────────────────────────────────────

      _name: function _name() {
        var inp = this.get("nameInput");
        return inp ? String(inp.textString || "").trim() : this._p.name;
      },

      makeInvitation: function makeInvitation() {
        var self = this, p = this._p;
        p.name = this._name();
        this.setStatus("Making an invitation…");
        lively.identity.localIdentity.peerOffer(p.name, function (err, r) {
          if (!self.world()) return;
          if (err) return self.setStatus("Could not make an invitation: " + (err.message || err), true);
          p.id = r.id; p.code = r.code; p.phase = "invited"; p.status = null;
          self.render();
        });
      },

      showEnter: function showEnter() {
        this._p.name = this._name();
        this._p.phase = "enter";
        this._p.status = null;
        this.render();
      },

      answerInvitation: function answerInvitation() {
        var self = this, p = this._p, box = this.get("pasteBox");
        var code = box ? String(box.textString || "") : "";
        if (!code.trim()) return this.setStatus("Paste the invitation first.", true);
        this.setStatus("Answering…");
        lively.identity.localIdentity.peerAnswer(code, p.name, function (err, r) {
          if (!self.world()) return;
          if (err) return self.setStatus(err.message || String(err), true);
          p.id = r.id; p.code = r.code; p.phase = "answered"; p.status = null;
          self.render();
        });
      },

      finishConnect: function finishConnect() {
        var self = this, p = this._p, box = this.get("pasteBox");
        var code = box ? String(box.textString || "") : "";
        if (!code.trim()) return this.setStatus("Paste the answer first.", true);
        this.setStatus("Connecting…");
        lively.identity.localIdentity.peerFinish(p.id, code, function (err) {
          if (!self.world()) return;
          if (err) return self.setStatus(err.message || String(err), true);
          // the 'ready' event moves on from here; until then the invitation stays on screen
          self.setStatus("Connecting…");
        });
      },

      copyCode: function copyCode() {
        var self = this;
        lively.identity.localIdentity.copyText(this._p.code, function (ok) {
          self.setStatus(ok ? "Copied." : "Could not copy. Select the text and copy it by hand.", !ok);
        });
      },

      copyPeerDid: function copyPeerDid() {
        var self = this, peer = this._p.peer;
        if (!peer) return;
        lively.identity.localIdentity.copyText(peer.did, function (ok) {
          self.setStatus(ok ? "Copied the other device's DID." : "Could not copy the DID.", !ok);
        });
      },

      // Back to the start; a connection that is still open is closed first.
      startOver: function startOver() {
        var p = this._p;
        if (p.id) lively.identity.localIdentity.peerClose(p.id);
        this._p = { phase: "start", name: p.name || p.defaultName || "", nameTouched: true, defaultName: p.defaultName, id: null, code: null, peer: null, why: null };
        this._rows = [];
        this.render();
      },

      chooseFiles: function chooseFiles() {
        var self = this, input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.style.display = "none";
        document.body.appendChild(input);
        input.addEventListener("change", function () {
          var files = Array.prototype.slice.call(input.files || []);
          if (input.parentNode) input.parentNode.removeChild(input);
          files.forEach(function (f) { self.sendFile(f); });
        });
        input.click();
      },

      sendFile: function sendFile(file) {
        var self = this, p = this._p;
        if (!p.id) return;
        lively.identity.localIdentity.peerSend(p.id, file, function (err, r) {
          if (!self.world()) return;
          if (err) return self.setStatus("Could not send " + file.name + ": " + (err.message || err), true);
          self._row("out", r.fid, { name: file.name, size: file.size, state: "offered" });
          self.render();
        });
      },

      _rowOf: function _rowOf(key) {
        var found = null;
        this._rows.forEach(function (r) { if (r.key === key) found = r; });
        return found;
      },

      onAccept: function onAccept(key) {
        var self = this, row = this._rowOf(key);
        if (!row) return;
        lively.identity.localIdentity.peerRespond(this._p.id, row.fid, true, function (err) {
          if (err) return self.setStatus(err.message || String(err), true);
          row.state = "receiving"; row.done = 0;
          self.render();
        });
      },

      onDecline: function onDecline(key) {
        var self = this, row = this._rowOf(key);
        if (!row) return;
        lively.identity.localIdentity.peerRespond(this._p.id, row.fid, false, function (err) {
          if (err) return self.setStatus(err.message || String(err), true);
          row.state = "declined";
          self.render();
        });
      },

      onStop: function onStop(key) {
        var self = this, row = this._rowOf(key);
        if (!row) return;
        lively.identity.localIdentity.peerCancel(this._p.id, row.fid, function (err) {
          if (err) return self.setStatus(err.message || String(err), true);
          row.state = "cancelled";
          self.render();
        });
      },

      onSave: function onSave(key) {
        var self = this, row = this._rowOf(key);
        if (!row) return;
        lively.identity.localIdentity.peerSave(this._p.id, row.fid, function (err) {
          if (err) return self.setStatus(err.message || String(err), true);
          row.state = "saved";
          self.render();
        });
      },

      // ─── helpers ────────────────────────────────────────────────────────────────

      setStatus: function setStatus(msg, isError) {
        this._p.status = msg ? { msg: msg, isError: !!isError } : null;
        var t = this.get("statusText");
        if (!t) return;
        t.setTextString(msg || "");
        t.setTextColor(isError ? Color.rgb(204, 51, 51) : Color.rgb(153, 153, 153));
      },
    });
  }); // end module('lively.identity.PeerDialog')
