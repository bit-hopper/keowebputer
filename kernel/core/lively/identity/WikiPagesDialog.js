/**
 * lively.identity.WikiPagesDialog
 *
 * Window listing the wiki pages kept on this device, inside keo only (the shell keeps them, shell/keo-wikipages.js), newest change first,
 * with a button to start a new one and a button on each row to open it in the editor (lively.identity.WikiEditor.openLocal). Nothing here
 * reads or writes a page: it asks the shell for the list (lively.identity.localIdentity.wikiList) and hands a page's name or id to the editor.
 *
 * A page is named by its owner and a name, so a name only has to be unique among this identity's own pages: asking for a name that is
 * already one of them opens that page. A page comes into being when it has been saved once, so a new page that was never typed in is not
 * in the list.
 *
 * The list is read again when the editor saves a page (it fires "keo-wiki-changed" on the window), and while the window is showing.
 *
 * Async convention: thenDo(err, result) throughout.
 *
 * Dependencies:
 *   lively.identity.LocalIdentity — the shell calls
 */

module("lively.identity.WikiPagesDialog")
  .requires(
    "lively.identity.LocalIdentity",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {
    lively.BuildSpec("lively.identity.WikiPagesDialog", {
      _BorderRadius: 7,
      _Extent: lively.pt(480, 200),
      _Fill: Color.rgb(255, 16, 144),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "IdentityWikiPagesDialog",
      titleBar: "Wiki pages",
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
          name: "wikiPagesContent",
          submorphs: [],
        },
      ],

      // ─── lifecycle ──────────────────────────────────────────────────────────────

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        $super();
        var self = this;
        this._ensureAccentChromeCss();
        this.addStyleClassName("identity-accent-chrome");
        this._d = { pages: null, status: null };
        // remove() runs whenever the window is taken out of the world, which also happens when it is brought forward (taken out and put
        // back at once), so the listener cannot be dropped there. A window that is really closed is not in the world when the next
        // event comes, and stops listening then.
        this._onChanged = function () {
          if (!self.world()) { window.removeEventListener("keo-wiki-changed", self._onChanged); return; }
          self.refresh();
        };
        window.addEventListener("keo-wiki-changed", this._onChanged);
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

      // Reads the list, then draws. A late answer for a window that is gone is dropped.
      refresh: function refresh() {
        var self = this, li = lively.identity.localIdentity, d = this._d;
        if (!d || !li.isAvailable()) return;
        li.wikiList(function (err, list) {
          if (!self.world() || !self._d) return;
          d.pages = err ? [] : (list || []);
          if (err) d.status = { msg: "Could not read your pages: " + (err.message || err), isError: true };
          self.render();
        });
      },

      // ─── drawing ────────────────────────────────────────────────────────────────

      // "18 Nov 2026, 09:12" in the person's own clock; "" for a page that has no time (a record from before it was kept).
      whenText: function whenText(iso) {
        var t = iso ? new Date(iso) : null;
        if (!t || isNaN(t.getTime())) return "";
        return t.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) + ", " +
          t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      },

      render: function render() {
        var self = this, content = this.get("wikiPagesContent"), d = this._d;
        if (!content || !d) return;
        content.removeAllMorphs();
        var pad = 14, W = 474, w = W - pad * 2, y = pad, MAXROWS = 12;

        function text(str, h, opts) {
          opts = opts || {};
          var t = new lively.morphic.Text(lively.rect(opts.x === undefined ? pad : opts.x, opts.y === undefined ? y : opts.y, opts.w || w, h), str);
          t.applyStyle({
            allowInput: false,
            fontFamily: "Arial, sans-serif",
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
        // see PhoneDialog._btn: applyStyle alone does not reach the DOM for a button made in code. kind: "main" (green, white words) or "plain".
        function button(str, name, x, bw, kind, method, argField, argValue, yy) {
          var b = new lively.morphic.Button(lively.rect(x, yy === undefined ? y : yy, bw, 24), str);
          b.name = name;
          if (argField) b[argField] = argValue;
          content.addMorph(b);
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
            lively.bindings.connect(b, "fire", self, method, { converter: function () { return this.sourceObj.rowKey; } });
          } else {
            lively.bindings.connect(b, "fire", self, method);
          }
          return b;
        }

        var local = lively.identity.localIdentity;
        if (!local.isAvailable()) {
          text("Wiki pages need keo webputer.", 20);
          y += 24;
        } else {
          text("Pages kept on this device. Each change you make is saved here, signed by you.", 22, { name: "introText" }); y += 28;
          var pages = d.pages;
          if (pages === null) {
            text("Reading your pages…", 20, { name: "readingText" }); y += 24;
          } else if (!pages.length) {
            text("No pages yet. Choose New page to start one.", 20, { name: "emptyText" }); y += 24;
          } else {
            pages.slice(0, MAXROWS).forEach(function (p) {
              var rowY = y, textW = w - 92;
              var nameT = text(p.name, 20, { y: rowY - 2, w: textW, size: 11, bold: true, name: "pageName" });
              nameT.pageId = p.id;
              var bits = [p.mine ? "yours" : "by " + local.shortDid(p.owner), p.versions + (p.versions === 1 ? " change" : " changes")];
              var when = self.whenText(p.updated);
              if (when) bits.push(when);
              if (p.pending) bits.push(p.pending + " waiting");
              var subT = text(bits.join("   ·   "), 18, { y: rowY + 16, w: textW, size: 8, color: Color.rgb(110, 110, 110), name: "pageInfo" });
              subT.pageId = p.id;
              button("Open", "openBtn", pad + w - 80, 80, "plain", "onOpen", "rowKey", p.id, rowY + 4);
              y += 40;
            });
            if (pages.length > MAXROWS) { text("(" + (pages.length - MAXROWS) + " older pages not shown)", 20, { name: "moreText" }); y += 24; }
          }
          y += 4;
          button("New page…", "newBtn", pad, 120, "main", "onNew");
          y += 32;
        }

        text("", 2 * 16 + 6, { name: "statusText" });
        y += 2 * 16 + 10;
        button("Close", "closeBtn", pad, 80, "plain", "remove");

        var contentH = y + 24 + pad;
        this.setExtent(lively.pt(W + 6, contentH + 28));
        content.setExtent(lively.pt(W, contentH));
        if (d.status) this.setStatus(d.status.msg, d.status.isError);
      },

      // ─── actions ────────────────────────────────────────────────────────────────

      // Opens a page the shell holds, by its id.
      onOpen: function onOpen(id) {
        this.setStatus("");
        lively.require("lively.identity.WikiEditor").toRun(function () {
          lively.identity.WikiEditor.openLocal({ id: id });
        });
      },

      // Asks for a name, then opens the page of that name (made when it is first saved; an existing page of that name is opened instead).
      onNew: function onNew() {
        var self = this;
        $world.prompt("Name of the new page:", function (name) {
          var n = String(name || "").trim();
          if (!n) return;
          // The shell holds the real rule (1 to 128 characters, no control character); this is only so the person is told here and not by an
          // error from the editor.
          if (n.length > 128 || /[\u0000-\u001f\u007f]/.test(n)) {
            if (self.world()) self.setStatus("A page name is 1 to 128 characters, with no control characters.", true);
            return;
          }
          if (self.world()) self.setStatus("");
          lively.require("lively.identity.WikiEditor").toRun(function () {
            lively.identity.WikiEditor.openLocal({ name: n });
          });
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

    Object.extend(lively.identity.WikiPagesDialog, {
      WINDOW_NAME: "IdentityWikiPagesDialog",

      // One window at a time, found by name: asking again brings the open one forward.
      open: function () {
        var open = $world.submorphs.filter(function (m) { return m.name === "IdentityWikiPagesDialog"; })[0];
        if (open) { open.comeForward(); return open; }
        var win = lively.BuildSpec("lively.identity.WikiPagesDialog").createMorph();
        win.openInWorldCenter();
        return win;
      },
    });
  }); // end module('lively.identity.WikiPagesDialog')
