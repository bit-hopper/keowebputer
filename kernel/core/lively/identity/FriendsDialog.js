/**
 * lively.identity.FriendsDialog
 *
 * Window listing the devices this identity has added as friends, inside keo only (the book is kept by the shell,
 * shell/keo-contacts.js). Files, messages and calls work only between friends: a device becomes one when each side has added the
 * other, and adding happens in a dialog the SHELL draws (from "Connect a device": Add as friend), never here. This window lists, opens
 * a conversation, asks to remove a friend (the shell asks the person first), and shows this identity's own eight words so they can be
 * read out to someone who is adding it.
 *
 * It never shows the other device's words: the point of the check is that the person types what the other person says.
 *
 * Two buttons ask the shell for the introduction screens (a QR code saying who a person is and where to reach them): one shows this
 * identity's own, one reads someone else's and adds them after the same eight-word check. Both screens are the shell's.
 *
 * In the desktop app a friend on the same network is found by their key: the row says so and has a Connect button that connects
 * with no codes passed (LocalIdentity.lanDial), and one line says whether this webputer is visible to friends on the network, with a
 * button to change it. Elsewhere (the extension) the shell reports the network as unavailable and none of that is drawn.
 *
 * Async convention: thenDo(err, result) throughout. The list is read again whenever the shell reports a change.
 *
 * Dependencies:
 *   lively.identity.LocalIdentity — the shell calls
 *   lively.identity.PostCardUtils — identiconDataUrl
 */

module("lively.identity.FriendsDialog")
  .requires(
    "lively.identity.LocalIdentity",
    "lively.identity.PostCardUtils",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {
    lively.BuildSpec("lively.identity.FriendsDialog", {
      _BorderRadius: 7,
      _Extent: lively.pt(480, 200),
      _Fill: Color.rgb(255, 16, 144),
      _ZIndex: 1000,
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "IdentityFriendsDialog",
      titleBar: "Friends",
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
          name: "friendsContent",
          submorphs: [],
        },
      ],

      // ─── lifecycle ──────────────────────────────────────────────────────────────

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        $super();
        var self = this, li = lively.identity.localIdentity;
        this._ensureAccentChromeCss();
        this.addStyleClassName("identity-accent-chrome");
        this._d = { friends: null, words: null, conns: {}, status: null, lan: null, dialing: {}, waitingFor: null };
        // remove() runs whenever the window is taken out of the world, which also happens when it is brought forward (taken out and put
        // back at once, e.g. by a click on it while another window is in front), so the subscriptions cannot be dropped there. A window
        // that is really closed is not in the world when the next event comes, and stops listening then.
        function live(fn) {
          return function (ev) {
            if (!self.world()) { (self._stops || []).forEach(function (stop) { try { stop(); } catch (e) {} }); self._stops = []; return; }
            fn(ev);
          };
        }
        this._stops = [
          li.onFriendEvent(live(function () { self.refresh(); })),
          li.onLanEvent(live(function () { self.refresh(); })),
          li.onPeerEvent(live(function (ev) { if (ev.type === "state" || ev.type === "friendship") self.refresh(); })),
        ];
        this.render();
        this.refresh();
      },

      // The title bar text is white on the accent colour (the same rule PeerDialog adds; whichever opens first adds it).
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

      // ─── data ───────────────────────────────────────────────────────────────────

      // Reads the four things the window shows, then draws. A late answer for a window that is gone is dropped.
      refresh: function refresh() {
        var self = this, li = lively.identity.localIdentity, d = this._d;
        if (!d || !li.isAvailable()) return;
        var left = 4;
        function got() { if (--left === 0 && self.world()) self.render(); }
        li.friendList(function (err, list) { d.friends = err ? [] : (list || []); if (err) self.setStatus("Could not read your friends: " + (err.message || err), true); got(); });
        li.friendWords(function (err, w) { d.words = err ? null : w; got(); });
        li.peerList(function (err, conns) {
          d.conns = {};
          (conns || []).forEach(function (c) { if (c.state === "ready" && c.peer) d.conns[c.peer.did] = c; });
          // a connection asked for here is up: the sentence that said it was being made is done
          if (d.waitingFor && d.conns[d.waitingFor]) { d.waitingFor = null; d.status = null; }
          got();
        });
        // An older shell has no network op: that reads as "not available", and nothing about the network is drawn.
        li.lanStatus(function (err, s) { d.lan = err || !s ? null : s; got(); });
      },

      // ─── drawing ────────────────────────────────────────────────────────────────

      render: function render() {
        var self = this, content = this.get("friendsContent"), d = this._d;
        if (!content || !d) return;
        content.removeAllMorphs();
        var pad = 14, W = 474, w = W - pad * 2, y = pad, MAXROWS = 8, AV = 32;

        function text(str, h, opts) {
          opts = opts || {};
          var t = new lively.morphic.Text(lively.rect(opts.x === undefined ? pad : opts.x, opts.y === undefined ? y : opts.y, opts.w || w, h), str);
          t.applyStyle({
            allowInput: false,
            fontFamily: opts.mono ? "Menlo, Consolas, monospace" : "Arial, sans-serif",
            fontSize: opts.size || 9,
            fontWeight: opts.bold ? "bold" : "normal",
            textColor: opts.color || Color.rgb(70, 70, 70),
            padding: lively.rect(4, 3, 0, 0),
            fill: opts.fill || null,
            borderWidth: 0,
            fixedWidth: true,
            fixedHeight: true,
            clipMode: "hidden",
          });
          if (opts.name) t.name = opts.name;
          content.addMorph(t);
          return t;
        }
        function paintButton(btn, borderColor, borderWidth, borderRadius, fill) {
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

        var local = lively.identity.localIdentity;
        if (!local.isAvailable()) {
          text("Friends need keo webputer.", 20);
          y += 24;
        } else {
          text("Your eight words. Read them to someone who is adding you:", 20); y += 20;
          text(d.words ? d.words.join(" ") : "…", 22, { mono: true, size: 10, bold: true, name: "myWords", fill: Color.rgb(238, 238, 244) }); y += 32;
          var friends = d.friends;
          if (friends === null) {
            text("Reading your friends…", 20); y += 24;
          } else if (!friends.length) {
            text("No friends yet. Connect to a device and choose Add as friend, or read an introduction.", 36, { name: "emptyText" }); y += 40;
          } else {
            var lan = d.lan && d.lan.available ? d.lan : null;
            var seenOnNet = {};
            if (lan) (lan.found || []).forEach(function (x) { seenOnNet[x.did] = true; });
            friends.slice(0, MAXROWS).forEach(function (f) {
              var conn = d.conns[f.did], rowY = y, onNet = !!seenOnNet[f.did];
              var av = new lively.morphic.Image(lively.rect(pad, rowY, AV, AV));
              av.name = "friendAvatar";
              av.applyStyle({ borderRadius: AV / 2, borderWidth: 0, clipMode: "hidden" });
              av.setImageURL(lively.identity.postCardUtils.identiconDataUrl(f.did, AV));
              av.ignoreEvents();
              content.addMorph(av);
              // Only a row that has a Connect button needs room for a third button: its three buttons are a little narrower and the
              // text beside them (the name and the line under it) gets what is left. Every other row is as it always was.
              var withConnect = !!(lan && !conn && onNet);
              var textW = w - AV - 8 - (withConnect ? 206 : 160);
              var nameT = text(f.name || "(showed no name)", 20, { x: pad + AV + 8, y: rowY - 2, w: textW, size: 11, bold: true, name: "friendName" });
              nameT.friendDid = f.did;
              var sub = local.shortDid(f.did) + (conn ? (conn.friend ? "   connected now, friends" : "   connected now, waiting for them to add you")
                : d.dialing[f.did] ? "   connecting …" : onNet ? "  on this network" : "   not connected");
              var subT = text(sub, 18, { x: pad + AV + 8, y: rowY + 16, w: textW, size: 8, color: Color.rgb(110, 110, 110), name: "friendDid" });
              subT.friendDid = f.did;
              if (withConnect) {
                button(d.dialing[f.did] ? "Trying…" : "Connect", "lanConnectBtn", pad + w - 198, 60, "main", "onLanConnect", "rowKey", f.did, rowY + 4);
                button("Message…", "messageBtn", pad + w - 134, 70, "plain", "onMessage", "rowKey", f.did, rowY + 4);
                button("Remove", "removeBtn", pad + w - 60, 60, "plain", "onRemove", "rowKey", f.did, rowY + 4);
              } else {
                button("Message…", "messageBtn", pad + w - 150, 76, "plain", "onMessage", "rowKey", f.did, rowY + 4);
                button("Remove", "removeBtn", pad + w - 70, 70, "plain", "onRemove", "rowKey", f.did, rowY + 4);
              }
              y += AV + 10;
            });
            if (friends.length > MAXROWS) { text("(" + (friends.length - MAXROWS) + " more not shown)", 20); y += 24; }
          }
          // The network, only where the app offers it. One line says whether this webputer announces itself to friends on the network,
          // with the button to change it; one hint says why nobody was found when friends exist and none is on the network.
          var net = d.lan && d.lan.available ? d.lan : null;
          if (net) {
            y += 2;
            text(net.visible ? "This webputer is visible to friends on this network." : "This webputer is hidden from friends on this network.", 18, { w: w - 90, name: "lanVisibleText" });
            button(net.visible ? "Hide" : "Show", "lanVisibleBtn", pad + w - 80, 80, "plain", "onLanVisible");
            y += 30;
            var anyHere = friends && friends.some(function (f) { return (net.found || []).some(function (x) { return x.did === f.did; }); });
            var hint = net.note || (friends && friends.length && !anyHere && !Object.keys(d.conns).length
              ? "None of your friends were found on this network. They need the app open, signed in and visible, on the same network. Some guest networks block this." : "");
            if (hint) { text(hint, 38, { size: 8, color: Color.rgb(110, 110, 110), name: "lanHint" }); y += 42; }
          }
          y += 4;
          button("Connect a device…", "connectBtn", pad, 150, "main", "onConnect");
          // The two screens for an introduction (a QR code of who someone is) are the shell's: these only ask for them to open.
          button("My introduction…", "introShowBtn", pad + 158, 120, "plain", "onIntroShow");
          button("Read an introduction…", "introReadBtn", pad + 286, 150, "plain", "onIntroRead");
          y += 32;
        }

        var status = text("", 2 * 16 + 6, { name: "statusText" });
        y += 2 * 16 + 10;
        button("Close", "closeBtn", pad, 80, "plain", "remove");

        var contentH = y + 24 + pad;
        this.setExtent(lively.pt(W + 6, contentH + 28));
        content.setExtent(lively.pt(W, contentH));
        if (d.status) this.setStatus(d.status.msg, d.status.isError);
      },

      // ─── actions ────────────────────────────────────────────────────────────────

      // A conversation with a friend (the window shows whether a connection is up).
      onMessage: function onMessage(did) {
        var name = null;
        ((this._d && this._d.friends) || []).forEach(function (f) { if (f.did === did) name = f.name; });
        lively.require("lively.identity.DMChat").toRun(function () {
          lively.identity.DMChat.openLocal(name || lively.identity.localIdentity.shortDid(did), did);
        });
      },

      // The shell asks the person first; this only learns the answer.
      onRemove: function onRemove(did) {
        var self = this;
        this.setStatus("Answer the question in the box that opened.");
        lively.identity.localIdentity.friendRemove(did, function (err) {
          if (!self.world()) return;
          if (err) return self.setStatus(err.message || String(err), true);
          self.setStatus("Removed.");
          self.refresh();
        });
      },

      // Connects to a friend found on the network, with no code passed. The call resolves once the connection is being made; the
      // peer events then say when it is up, and refresh() clears the sentence.
      onLanConnect: function onLanConnect(did) {
        var self = this, d = this._d;
        if (!d || d.dialing[did]) return;
        d.dialing[did] = true;
        this.setStatus("Connecting to your friend on this network …");
        this.render();
        lively.identity.localIdentity.lanDial(did, function (err) {
          var dd = self._d;
          if (!dd) return;
          delete dd.dialing[did];
          if (err) { dd.waitingFor = null; self.setStatus(err.message || String(err), true); }
          else dd.waitingFor = did;
          if (self.world()) self.refresh();
        });
      },

      // Shows or hides this webputer to friends on the network (kept with the identity by the shell).
      onLanVisible: function onLanVisible() {
        var self = this, d = this._d;
        if (!d || !d.lan) return;
        lively.identity.localIdentity.lanVisible(!d.lan.visible, function (err) {
          if (!self.world()) return;
          if (err) self.setStatus(err.message || String(err), true);
          self.refresh();
        });
      },

      // The shell draws the screen (our QR code, or the one that reads someone's and adds them after the eight-word check); this only asks
      // for it and learns whether it opened. Adding is told through the friend event, which refreshes the list.
      onIntroShow: function onIntroShow() { this._askIntro("introShow"); },
      onIntroRead: function onIntroRead() { this._askIntro("introRead"); },
      _askIntro: function _askIntro(op) {
        var self = this;
        lively.identity.localIdentity[op](function (err) {
          if (!self.world()) return;
          if (err) return self.setStatus(err.message || String(err), true);
          self.setStatus("");
        });
      },

      onConnect: function onConnect() {
        lively.require("lively.identity.PeerDialog").toRun(function () {
          lively.BuildSpec("lively.identity.PeerDialog").createMorph().openInWorldCenter();
        });
      },

      // ─── helpers ────────────────────────────────────────────────────────────────

      setStatus: function setStatus(msg, isError) {
        if (this._d) this._d.status = msg ? { msg: msg, isError: !!isError } : null;
        var t = this.get("statusText");
        if (!t) return;
        t.setTextString(msg || "");
        t.setTextColor(isError ? Color.rgb(204, 51, 51) : Color.rgb(153, 153, 153));
      },
    });
  }); // end module('lively.identity.FriendsDialog')
